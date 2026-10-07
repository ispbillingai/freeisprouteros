#!/usr/bin/env python3
"""Behavioral tests of the real Hotspot model with a deterministic adapter.

Run: python3 -B tools/openwrt/test_hotspot.py. Network packet enforcement is
tested separately by test_hotspot_runtime.py and the Linux namespace smoke.
"""
import concurrent.futures
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[2] / "openwrt/files/usr/lib/freeisp/hotspot.py"
SPEC = importlib.util.spec_from_file_location("freeisp_hotspot", MODULE)
hotspot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hotspot)


class FakeRuntime:
    def __init__(self):
        self.config = None
        self.sessions = []
        self.counters = {}
        self.peers = {}
        self.fail = False
        self.observe_fail = False
        self.resets = []
        self.configures = 0

    def configure(self, config, sessions):
        self.configures += 1
        if self.fail:
            raise RuntimeError("simulated nft transaction rejected")
        self.config = copy.deepcopy(config)
        self.sessions = copy.deepcopy(sessions)

    def observe(self, config):
        if self.observe_fail:
            raise RuntimeError("network service missing")
        return {"available": True, "error": "", "interfaces": [{"name": "br-guest", "eligible": True}],
                "hosts": [{"id": ip, "address": ip, "mac_address": peer["mac"]}
                          for ip, peer in self.peers.items()], "counters": copy.deepcopy(self.counters)}

    def client(self, ip):
        if ip not in self.peers:
            raise RuntimeError("not in neighbor table")
        return dict(self.peers[ip], ip=ip)

    def reset_html(self, server):
        self.resets.append(server["id"])


class HotspotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="freeisp-hotspot-test-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.now = 2000000000.0
        self.runtime = FakeRuntime()
        self.engine = hotspot.Engine(str(self.path / "config.json"), str(self.path / "state.json"),
                                     self.runtime, lambda: self.now)

    def mutate(self, action, **payload):
        return self.engine.dispatch(action, dict(payload, revision=self.engine.config["revision"]))

    def save(self, collection, **record):
        return self.mutate("save", collection=collection, record=record)["id"]

    def setup_network(self, **user_options):
        self.server = self.mutate("setup", name="guest", interface="br-guest", address_pool="10.42.0.0/24",
                                  local_address="10.42.0.1", dns_name="login.example.test")["id"]
        self.profile = self.engine.config["collections"]["user_profiles"][0]["id"]
        self.server_profile = self.engine.config["collections"]["server_profiles"][0]["id"]
        self.user = self.save("users", name="alice", password="a very secret password", profile=self.profile,
                              **user_options)
        self.runtime.peers["10.42.0.2"] = {"mac": "02:00:00:00:00:02", "server_id": self.server}
        self.runtime.peers["10.42.0.3"] = {"mac": "02:00:00:00:00:03", "server_id": self.server}

    def login(self, ip="10.42.0.2", **options):
        return self.engine.login("alice", "a very secret password", ip,
                                 self.runtime.peers[ip]["mac"], self.server, **options)

    def assertError(self, code, operation):
        with self.assertRaises(hotspot.HotspotError) as caught:
            operation()
        self.assertEqual(code, caught.exception.code, caught.exception.message)
        return caught.exception

    def test_tightened_device_limit_revokes_newer_address_immediately(self):
        self.setup_network()
        self.save("user_profiles", id=self.profile, shared_users=2)
        self.runtime.peers["10.42.0.3"]["mac"] = self.runtime.peers["10.42.0.2"]["mac"]
        first = self.login()["session"]["id"]
        self.now += 1
        self.login("10.42.0.3")
        self.assertEqual(2, len(self.runtime.sessions))
        self.save("servers", id=self.server, addresses_per_mac=1)
        self.assertEqual([first], [s["id"] for s in self.runtime.sessions])
        self.assertError("limit", lambda: self.login("10.42.0.3"))

    def test_tightened_shared_limit_revokes_newer_session_immediately(self):
        self.setup_network()
        self.save("user_profiles", id=self.profile, shared_users=2)
        first = self.login()["session"]["id"]
        self.now += 1
        self.login("10.42.0.3")
        self.save("user_profiles", id=self.profile, shared_users=1)
        self.assertEqual([first], [s["id"] for s in self.runtime.sessions])

    def test_disconnect_and_logout_checkpoint_failure_restore_runtime_sessions(self):
        self.setup_network()
        session = self.login()["session"]["id"]
        original = hotspot._atomic_json
        for action in ("disconnect", "logout"):
            with self.subTest(action=action):
                failed = []
                def fail_once(path, value):
                    if path == self.engine.state_path and not failed:
                        failed.append(True)
                        raise OSError("Simulated full state disk")
                    return original(path, value)
                with mock.patch.object(hotspot, "_atomic_json", side_effect=fail_once), self.assertRaises(OSError):
                    if action == "disconnect":
                        self.mutate(action, ids=[session])
                    else:
                        self.engine.logout(session, "10.42.0.2")
                self.assertEqual([session], [row["id"] for row in self.engine.state["sessions"]])
                self.assertEqual([session], [row["id"] for row in self.runtime.sessions])

    def test_empty_snapshot_has_all_eleven_collections_and_status(self):
        snapshot = self.engine.snapshot()
        self.assertEqual(0, snapshot["revision"])
        self.assertEqual(set(hotspot.COLLECTIONS) | {"active", "hosts", "cookies"}, set(snapshot["collections"]))
        self.assertTrue(snapshot["runtime"]["available"])
        self.assertEqual("br-guest", snapshot["interfaces"][0]["name"])

    def test_all_editable_collections_create_edit_enable_disable_remove(self):
        self.setup_network()
        rows = {
            "ip_bindings": {"address": "10.42.0.4", "type": "bypassed"},
            "service_ports": {"name": "local-web", "ports": "8080,8443-8445"},
            "walled_garden": {"host": "payment.example.test", "port": 443},
            "walled_garden_ip": {"dst_address": "203.0.113.0/24", "protocol": "tcp", "dst_port": "443"},
            "server_profiles": {"name": "spare", "hotspot_address": "10.43.0.1"},
            "user_profiles": {"name": "premium", "rate_limit_up": 65536, "rate_limit_down": 131072},
            "users": {"name": "bob", "password": "test", "profile": self.profile},
            "servers": {"name": "second", "interface": "br-guest2", "address_pool": "10.42.0.0/24",
                        "profile": self.server_profile},
        }
        for collection, fields in rows.items():
            with self.subTest(collection=collection):
                identity = self.save(collection, **fields)
                self.save(collection, id=identity, comment="Edited record")
                self.mutate("set_enabled", collection=collection, ids=[identity], enabled=False)
                row = self.engine._lookup(collection, identity)
                self.assertTrue(row["disabled"])
                self.assertEqual("Edited record", row["comment"])
                self.mutate("set_enabled", collection=collection, ids=[identity], enabled=True)
                self.assertFalse(self.engine._lookup(collection, identity)["disabled"])
                self.mutate("remove", collection=collection, ids=[identity])
                self.assertIsNone(self.engine._lookup(collection, identity))

    def test_stale_revision_does_not_overwrite_another_admin(self):
        self.save("user_profiles", name="first")
        self.assertError("conflict", lambda: self.engine.dispatch("save", {
            "collection": "user_profiles", "record": {"name": "second"}, "revision": 0}))
        self.assertEqual(["first"], [p["name"] for p in self.engine.config["collections"]["user_profiles"]])

    def test_concurrent_same_revision_only_one_write_succeeds(self):
        def save(name):
            try:
                return self.engine.dispatch("save", {"collection": "user_profiles", "record": {"name": name}, "revision": 0})
            except hotspot.HotspotError as exc:
                return exc.as_dict()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(save, ["one", "two"]))
        self.assertEqual(1, sum(result["ok"] for result in results))
        self.assertEqual(1, self.engine.config["revision"])

    def test_name_and_id_uniqueness_not_found_and_atomic_multi_remove(self):
        identity = self.save("user_profiles", name="standard")
        self.assertError("validation", lambda: self.save("user_profiles", name="standard"))
        self.assertError("not_found", lambda: self.save("user_profiles", id="missing", name="changed"))
        self.assertError("not_found", lambda: self.mutate("remove", collection="user_profiles", ids=[identity, "missing"]))
        self.assertIsNotNone(self.engine._lookup("user_profiles", identity))

    def test_reference_integrity_prevents_removing_in_use_profiles_and_servers(self):
        self.setup_network(server="all")
        for collection, identity in [("user_profiles", self.profile), ("server_profiles", self.server_profile)]:
            self.assertError("reference", lambda c=collection, i=identity: self.mutate("remove", collection=c, ids=[i]))
        self.save("users", id=self.user, server=self.server)
        self.assertError("reference", lambda: self.mutate("remove", collection="servers", ids=[self.server]))

    def test_strict_validation_and_command_injection_rejected(self):
        bad = [
            ("user_profiles", {"name": "x", "shared_users": True}),
            ("user_profiles", {"name": "x", "shared_users": 0}),
            ("user_profiles", {"name": "x", "session_timeout": -1}),
            ("user_profiles", {"name": "x", "disabled": "false"}),
            ("user_profiles", {"name": "x", "unknown": 1}),
            ("service_ports", {"name": "x", "ports": "80; reboot"}),
            ("service_ports", {"name": "x", "ports": "90-80"}),
            ("service_ports", {"name": "x", "ports": "65536"}),
            ("walled_garden", {"host": "*.example.test"}),
            ("walled_garden", {"host": "https://example.test/path"}),
            ("walled_garden", {"host": "example.test\nreboot"}),
            ("walled_garden_ip", {"dst_address": "::1"}),
            ("walled_garden_ip", {"dst_address": "1.2.3.4", "protocol": "icmp", "dst_port": "80"}),
            ("ip_bindings", {"mac_address": "ff:ff:ff:ff:ff:ff"}),
            ("ip_bindings", {}),
            ("server_profiles", {"name": "x", "hotspot_address": "10.0.0.1", "http_port": 80}),
            ("server_profiles", {"name": "x", "hotspot_address": "127.0.0.1"}),
        ]
        for collection, record in bad:
            with self.subTest(collection=collection, record=record):
                self.assertError("validation", lambda: self.save(collection, **record))
        self.assertEqual(0, self.engine.config["revision"])

    def test_setup_validates_network_and_rolls_back_as_single_operation(self):
        self.assertError("validation", lambda: self.mutate("setup", interface="br-guest", address_pool="10.42.0.0/24",
                                                           local_address="10.43.0.1"))
        self.assertEqual(0, self.engine.config["revision"])
        self.assertFalse(self.engine.config["collections"]["server_profiles"])
        self.assertError("validation", lambda: self.mutate("setup", interface="br-guest; touch /tmp/bad",
                                                           address_pool="10.42.0.0/24", local_address="10.42.0.1"))

    def test_setup_and_reset_html(self):
        self.setup_network()
        result = self.mutate("reset_html", server_id=self.server)
        self.assertTrue(result["ok"])
        self.assertEqual([self.server], self.runtime.resets)
        self.assertError("not_found", lambda: self.mutate("reset_html", server_id="missing"))

    def test_runtime_rejection_rolls_back_revision_disk_and_sessions(self):
        self.setup_network()
        session = self.login()["session"]
        before = json.loads((self.path / "config.json").read_text())
        self.runtime.fail = True
        self.assertError("runtime", lambda: self.save("users", id=self.user, disabled=True))
        self.assertEqual(before, json.loads((self.path / "config.json").read_text()))
        self.assertEqual(session["id"], self.engine.state["sessions"][0]["id"])
        self.assertFalse(self.engine._lookup("users", self.user)["disabled"])

    def test_state_write_failure_after_config_write_restores_config_on_disk(self):
        self.setup_network()
        before = json.loads((self.path / "config.json").read_text())
        real_atomic = hotspot._atomic_json
        fail_once = [True]
        def failing(path, value):
            if path == self.engine.state_path and fail_once[0]:
                fail_once[0] = False
                raise OSError("simulated disk full during state checkpoint")
            return real_atomic(path, value)
        with mock.patch.object(hotspot, "_atomic_json", side_effect=failing):
            with self.assertRaises(OSError):
                self.save("users", id=self.user, comment="must rollback")
        self.assertEqual(before, json.loads((self.path / "config.json").read_text()))
        self.assertEqual(before, self.engine.config)
        self.assertEqual(before, self.runtime.config)

    def test_password_storage_redaction_and_blank_edit_preserves_password(self):
        self.setup_network()
        encoded = self.engine._lookup("users", self.user)["password_hash"]
        self.assertTrue(encoded.startswith("pbkdf2_sha256$260000$"))
        self.assertNotIn("a very secret password", (self.path / "config.json").read_text())
        self.save("users", id=self.user, password="", comment="preserve")
        self.assertEqual(encoded, self.engine._lookup("users", self.user)["password_hash"])
        self.login(remember=True)
        snapshot = json.dumps(self.engine.snapshot())
        for private in ("password_hash", "token_hash", encoded, "a very secret password"):
            self.assertNotIn(private, snapshot)
        if os.name != "nt":
            self.assertEqual(0o600, stat.S_IMODE((self.path / "config.json").stat().st_mode))

    def test_wrong_password_and_unknown_user_never_authorize(self):
        self.setup_network()
        for name in ("alice", "does-not-exist"):
            self.assertError("authentication", lambda n=name: self.engine.login(n, "wrong", "10.42.0.2",
                             "02:00:00:00:00:02", self.server))
        self.assertFalse(self.runtime.sessions)
        self.assertFalse(self.engine.state["sessions"])

    def test_login_throttles_failures_and_recovers_after_window(self):
        self.setup_network()
        for _ in range(10):
            self.assertError("authentication", lambda: self.engine.login("alice", "bad", "10.42.0.2",
                             "02:00:00:00:00:02", self.server))
        self.assertError("rate_limited", self.login)
        self.now += 301
        self.assertTrue(self.login()["ok"])

    def test_neighbor_identity_and_bound_account_are_enforced(self):
        self.setup_network(mac_address="02:00:00:00:00:02")
        self.assertError("authentication", lambda: self.engine.login("alice", "a very secret password",
                         "10.42.0.2", "02:00:00:00:00:99", self.server))
        self.assertError("authentication", lambda: self.login(ip="10.42.0.3"))
        self.assertError("authentication", lambda: self.engine.login("alice", "a very secret password",
                         "10.42.0.99", "02:00:00:00:00:99", self.server))
        self.assertFalse(self.engine.state["sessions"])

    def test_shared_login_limit_and_same_client_relogin(self):
        self.setup_network()
        first = self.login()["session"]
        second = self.login()["session"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(1, len(self.engine.state["sessions"]))
        self.assertError("limit", lambda: self.login(ip="10.42.0.3"))
        self.save("user_profiles", id=self.profile, shared_users=2)
        self.login(ip="10.42.0.3")
        self.assertEqual(2, len(self.engine.state["sessions"]))

    def test_disabled_user_profile_server_and_server_profile_disconnect(self):
        for collection in ("users", "user_profiles", "servers", "server_profiles"):
            with self.subTest(collection=collection):
                if not hasattr(self, "server"):
                    self.setup_network()
                identity = {"users": self.user, "user_profiles": self.profile, "servers": self.server,
                            "server_profiles": self.server_profile}[collection]
                self.login(remember=True)
                self.mutate("set_enabled", collection=collection, ids=[identity], enabled=False)
                self.assertFalse(self.engine.state["sessions"])
                self.assertFalse(self.engine.state["cookies"])
                self.assertFalse(self.runtime.sessions)
                self.assertError("authentication", self.login)
                self.mutate("set_enabled", collection=collection, ids=[identity], enabled=True)

    def test_password_change_revokes_active_sessions_and_cookies(self):
        self.setup_network()
        result = self.login(remember=True)
        self.save("users", id=self.user, password="new-password")
        self.assertFalse(self.runtime.sessions)
        self.assertFalse(self.engine.state["cookies"])
        self.assertError("authentication", self.login)
        self.assertError("authentication", lambda: self.engine.login_cookie(result["cookie"], "10.42.0.2",
                         "02:00:00:00:00:02", self.server))

    def test_cookie_login_device_binding_deletion_and_expiry(self):
        self.setup_network()
        result = self.login(remember=True)
        token = result["cookie"]
        self.assertNotIn(token, (self.path / "state.json").read_text())
        self.engine.dispatch("disconnect", {"ids": [result["session"]["id"]]})
        self.assertTrue(self.engine.login_cookie(token, "10.42.0.2", "02:00:00:00:00:02", self.server)["ok"])
        self.assertError("authentication", lambda: self.engine.login_cookie(token, "10.42.0.3",
                         "02:00:00:00:00:03", self.server))
        cookie_id = self.engine.state["cookies"][0]["id"]
        self.engine.dispatch("remove_cookies", {"ids": [cookie_id]})
        self.assertError("authentication", lambda: self.engine.login_cookie(token, "10.42.0.2",
                         "02:00:00:00:00:02", self.server))
        token = self.login(remember=True)["cookie"]
        self.now += 86401
        self.assertError("authentication", lambda: self.engine.login_cookie(token, "10.42.0.2",
                         "02:00:00:00:00:02", self.server))
        self.assertFalse(self.engine.state["cookies"])

    def test_logout_removes_matching_cookies_and_rejects_other_client(self):
        self.setup_network()
        result = self.login(remember=True)
        identity = result["session"]["id"]
        self.assertError("not_found", lambda: self.engine.logout(identity, "10.42.0.3"))
        self.engine.logout(identity, "10.42.0.2")
        self.assertFalse(self.engine.state["sessions"])
        self.assertFalse(self.engine.state["cookies"])
        self.assertFalse(self.runtime.sessions)

    def test_session_timeout_idle_timeout_and_traffic_activity(self):
        self.setup_network()
        self.save("user_profiles", id=self.profile, session_timeout=60, idle_timeout=10)
        identity = self.login()["session"]["id"]
        self.now += 9
        self.runtime.counters[identity] = {"bytes_in": 100, "bytes_out": 200}
        self.engine.poll()
        self.now += 9
        self.engine.poll()
        self.assertEqual(1, len(self.engine.state["sessions"]))
        self.now += 2
        self.engine.poll()
        self.assertFalse(self.engine.state["sessions"])
        self.save("user_profiles", id=self.profile, idle_timeout=0)
        self.login()
        self.now += 60
        self.engine.poll()
        self.assertFalse(self.engine.state["sessions"])

    def test_lifetime_byte_quota_counts_deltas_and_counter_reset(self):
        self.setup_network(limit_bytes_in=300)
        identity = self.login()["session"]["id"]
        for incoming, total in [(100, 100), (100, 100), (180, 180), (20, 200), (120, 300)]:
            self.runtime.counters[identity] = {"bytes_in": incoming, "bytes_out": 10}
            self.engine.poll()
            self.assertEqual(total, self.engine.state["usage"][self.user]["bytes_in"])
        self.assertFalse(self.runtime.sessions)
        self.assertError("limit", self.login)
        self.assertEqual(300, self.engine.snapshot()["collections"]["users"][0]["bytes_in"])

    def test_uptime_quota_survives_restart_and_sessions_do_not(self):
        self.setup_network(limit_uptime=30)
        self.login(remember=True)
        self.now += 30
        self.engine.poll()
        restarted = hotspot.Engine(self.engine.config_path, self.engine.state_path, self.runtime, lambda: self.now)
        self.assertFalse(restarted.state["sessions"])
        self.assertEqual(30, restarted.state["usage"][self.user]["uptime"])
        self.assertError("limit", lambda: restarted.login("alice", "a very secret password", "10.42.0.2",
                         "02:00:00:00:00:02", self.server))

    def test_blocked_binding_revokes_existing_session_and_rejects_login(self):
        self.setup_network()
        self.login()
        self.save("ip_bindings", address="10.42.0.2", type="blocked")
        self.assertFalse(self.runtime.sessions)
        self.assertError("authentication", self.login)

    def test_periodic_poll_refreshes_authorization_lease(self):
        self.setup_network()
        self.login()
        calls = self.runtime.configures
        self.engine.poll()
        self.engine.poll()
        self.assertEqual(calls + 2, self.runtime.configures)

    def test_snapshot_reports_runtime_error_even_when_session_expiry_reconcile_fails(self):
        self.setup_network()
        self.save("user_profiles", id=self.profile, idle_timeout=1)
        self.login()
        self.now += 2
        self.runtime.fail = True
        snapshot = self.engine.snapshot()
        self.assertFalse(snapshot["runtime"]["available"])
        self.assertIn("simulated nft", snapshot["runtime"]["error"])
        self.assertFalse(snapshot["collections"]["active"])
        self.assertError("runtime", self.engine.poll)

    def test_corrupt_files_fail_closed_and_are_not_overwritten(self):
        self.setup_network()
        self.path.joinpath("config.json").write_text("{broken", encoding="utf-8")
        self.assertError("storage", self.engine.snapshot)
        self.assertEqual("{broken", self.path.joinpath("config.json").read_text())

    def test_persisted_untrusted_fields_are_revalidated(self):
        self.setup_network()
        config = copy.deepcopy(self.engine.config)
        config["collections"]["servers"][0]["interface"] = "br-guest;reboot"
        self.path.joinpath("config.json").write_text(json.dumps(config), encoding="utf-8")
        self.assertError("validation", self.engine.snapshot)

    def test_unknown_actions_and_readonly_collections_cannot_mutate(self):
        self.assertError("unknown_action", lambda: self.engine.dispatch("shell", {"command": "reboot"}))
        self.assertError("validation", lambda: self.save("active", name="fake-session"))
        self.assertError("validation", lambda: self.engine.dispatch("save", "bad payload"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
