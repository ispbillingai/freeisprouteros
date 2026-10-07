#!/usr/bin/env python3
"""FreeISP local Hotspot model, durable configuration and authentication.

The daemon is the sole public writer.  Config revisions reject stale browser
edits; an advisory lock also protects local administrative callers. Passwords
and bearer cookies never leave this module through management snapshots.
"""
import copy
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager

try:
    import fcntl
except ImportError:  # Unit tests also run on the Windows management workstation.
    fcntl = None


class HotspotError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self):
        return {"ok": False, "error": {"code": self.code, "message": self.message}}


COLLECTIONS = ("servers", "server_profiles", "users", "user_profiles",
               "ip_bindings", "service_ports", "walled_garden", "walled_garden_ip")
DEFAULTS = {
    "servers": {"name": "", "interface": "", "address_pool": "", "profile": "",
                "addresses_per_mac": 2},
    "server_profiles": {"name": "", "hotspot_address": "", "dns_name": "",
                        "http_port": 6480, "cookie_login": True, "cookie_lifetime": 86400},
    "user_profiles": {"name": "", "shared_users": 1, "session_timeout": 0,
                      "idle_timeout": 300, "rate_limit_up": 0, "rate_limit_down": 0},
    "users": {"name": "", "profile": "", "server": "all", "mac_address": "",
              "limit_uptime": 0, "limit_bytes_in": 0, "limit_bytes_out": 0},
    "ip_bindings": {"address": "", "mac_address": "", "server": "all", "type": "regular"},
    "service_ports": {"name": "", "protocol": "tcp", "ports": ""},
    "walled_garden": {"server": "all", "host": "", "port": 0, "action": "allow"},
    "walled_garden_ip": {"server": "all", "dst_address": "", "protocol": "any",
                         "dst_port": "", "action": "allow"},
}
COMMON = {"disabled": False, "comment": ""}
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
IFACE_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,15}$")
HOST_PATTERN = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.I)
MAC_PATTERN = re.compile(r"^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$", re.I)
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def _error(message, code="validation"):
    raise HotspotError(code, message)


def _identifier():
    return uuid.uuid4().hex


def _atomic_json(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".hotspot-", dir=directory)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as stream:
            result = json.load(stream)
    except FileNotFoundError:
        return copy.deepcopy(default)
    except (ValueError, OSError) as exc:
        raise HotspotError("storage", "Cannot read Hotspot state: %s" % exc) from exc
    if not isinstance(result, dict):
        _error("Hotspot storage must contain a JSON object", "storage")
    return result


def _password_hash(password):
    if not isinstance(password, str) or not 1 <= len(password.encode("utf-8")) <= 1024:
        _error("Password must contain 1 to 1024 UTF-8 bytes")
    salt = secrets.token_bytes(16)
    rounds = 260000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return "pbkdf2_sha256$%d$%s$%s" % (rounds, salt.hex(), digest.hex())


def _password_matches(password, encoded):
    try:
        algorithm, rounds, salt, digest = encoded.split("$")
        iterations = int(rounds)
        if algorithm != "pbkdf2_sha256" or not 10000 <= iterations <= 2000000:
            return False
        if not isinstance(password, str) or len(password.encode("utf-8")) > 1024:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
        return hmac.compare_digest(actual.hex(), digest)
    except (ValueError, TypeError, AttributeError):
        return False


def _int(value, name, maximum=2**53-1, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        _error("%s must be an integer between %d and %d" % (name, minimum, maximum))
    return value


def _text(value, name, maximum=255, required=False):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
        _error("%s must be plain text up to %d characters" % (name, maximum))
    value = value.strip()
    if required and not value:
        _error("%s is required" % name)
    return value


def _ipv4(value, name, network=False, empty=False):
    value = _text(value, name)
    if empty and not value:
        return ""
    try:
        address = ipaddress.ip_network(value, strict=False) if network else ipaddress.ip_address(value)
        if address.version != 4:
            raise ValueError()
        if address.is_multicast or address.is_loopback or address.is_unspecified:
            raise ValueError()
        return str(address)
    except ValueError:
        _error("%s must be a usable IPv4 %s" % (name, "address or subnet" if network else "address"))


def _mac(value, required=False):
    value = _text(value, "MAC address").lower()
    if not value and not required:
        return ""
    if not MAC_PATTERN.fullmatch(value) or int(value[:2], 16) & 1 or value == "00:00:00:00:00:00":
        _error("A unicast MAC address is required")
    return value


def _ports(value, name="Ports", empty=False):
    value = _text(value, name)
    if empty and not value:
        return ""
    parts = value.split(",")
    if len(parts) > 64:
        _error("At most 64 port entries are allowed")
    normalized = []
    for part in parts:
        if not re.fullmatch(r"\d{1,5}(?:-\d{1,5})?", part.strip()):
            _error("%s must be comma-separated ports or ranges" % name)
        pair = [int(x) for x in part.strip().split("-")]
        if not all(1 <= x <= 65535 for x in pair) or pair[0] > pair[-1]:
            _error("%s contains an invalid port range" % name)
        normalized.append("-".join(str(x) for x in pair))
    return ",".join(normalized)


def _hostname(value, name, empty=False):
    value = _text(value, name).lower().rstrip(".")
    if empty and not value:
        return ""
    if not HOST_PATTERN.fullmatch(value):
        _error("%s must be a DNS hostname without wildcards, paths or schemes" % name)
    return value


def _record(collection, incoming, existing=None):
    if collection not in COLLECTIONS:
        _error("Unknown editable collection")
    if not isinstance(incoming, dict):
        _error("Record must be an object")
    allowed = set(DEFAULTS[collection]) | set(COMMON) | {"id"}
    if collection == "users":
        allowed.add("password")
    unknown = set(incoming) - allowed
    if unknown:
        _error("Unknown fields: %s" % ", ".join(sorted(unknown)))
    value = dict(DEFAULTS[collection], **COMMON)
    if existing:
        value.update(existing)
    value.update(incoming)
    value["id"] = value.get("id") or _identifier()
    if not isinstance(value["id"], str) or not ID_PATTERN.fullmatch(value["id"]):
        _error("Invalid record id")
    if type(value["disabled"]) is not bool:
        _error("Disabled must be true or false")
    value["comment"] = _text(value["comment"], "Comment", 1024)
    if "name" in value:
        value["name"] = _text(value["name"], "Name", 128, True)
    if "server" in value:
        value["server"] = _text(value["server"], "Server", 80, True)
    if "profile" in value:
        value["profile"] = _text(value["profile"], "Profile", 80, True)
    if "mac_address" in value:
        value["mac_address"] = _mac(value["mac_address"])
    if collection == "servers":
        value["interface"] = _text(value["interface"], "Interface")
        if not IFACE_PATTERN.fullmatch(value["interface"]):
            _error("Interface must be a Linux device name")
        value["address_pool"] = _ipv4(value["address_pool"], "Address pool", network=True)
        if ipaddress.ip_network(value["address_pool"]).prefixlen > 30:
            _error("Address pool must have at least two usable host addresses")
        _int(value["addresses_per_mac"], "Addresses per MAC", 64, 1)
    elif collection == "server_profiles":
        value["hotspot_address"] = _ipv4(value["hotspot_address"], "Hotspot address")
        value["dns_name"] = _hostname(value["dns_name"], "DNS name", empty=True)
        _int(value["http_port"], "HTTP port", 65535, 1024)
        if type(value["cookie_login"]) is not bool:
            _error("Cookie login must be true or false")
        _int(value["cookie_lifetime"], "Cookie lifetime", 31536000, 60)
    elif collection == "user_profiles":
        _int(value["shared_users"], "Shared users", 1000, 1)
        for key in ("session_timeout", "idle_timeout", "rate_limit_up", "rate_limit_down"):
            _int(value[key], key, 2**40)
    elif collection == "users":
        for key in ("limit_uptime", "limit_bytes_in", "limit_bytes_out"):
            _int(value[key], key)
        password = value.pop("password", None)
        if password:
            value["password_hash"] = _password_hash(password)
        elif not existing:
            _error("A password is required for a new user")
        elif password is not None and not isinstance(password, str):
            _error("Password must be text")
    elif collection == "ip_bindings":
        value["address"] = _ipv4(value["address"], "Address", network=True, empty=True)
        if not value["address"] and not value["mac_address"]:
            _error("An IP binding needs an address or MAC address")
        if value["type"] not in ("regular", "bypassed", "blocked"):
            _error("IP binding type must be regular, bypassed or blocked")
    elif collection == "service_ports":
        if value["protocol"] not in ("tcp", "udp"):
            _error("Service protocol must be tcp or udp")
        value["ports"] = _ports(value["ports"])
    elif collection == "walled_garden":
        value["host"] = _hostname(value["host"], "Host")
        _int(value["port"], "Port", 65535)
        if value["action"] not in ("allow", "deny"):
            _error("Action must be allow or deny")
    elif collection == "walled_garden_ip":
        value["dst_address"] = _ipv4(value["dst_address"], "Destination address", network=True)
        if value["protocol"] not in ("any", "tcp", "udp", "icmp"):
            _error("Protocol must be any, tcp, udp or icmp")
        value["dst_port"] = _ports(value["dst_port"], "Destination port", empty=True)
        if value["dst_port"] and value["protocol"] not in ("tcp", "udp"):
            _error("Destination ports require tcp or udp")
        if value["action"] not in ("allow", "deny"):
            _error("Action must be allow or deny")
    return value


def _validate_config(config):
    if config.get("schema") != 1 or type(config.get("revision")) is not int:
        _error("Unsupported Hotspot configuration schema", "storage")
    tables = config.get("collections")
    if not isinstance(tables, dict) or set(tables) != set(COLLECTIONS):
        _error("Invalid Hotspot configuration collections", "storage")
    for collection, rows in tables.items():
        if not isinstance(rows, list) or len(rows) > 10000:
            _error("Invalid or oversized collection: " + collection)
        ids, names = set(), set()
        for row in rows:
            if not isinstance(row, dict) or not ID_PATTERN.fullmatch(str(row.get("id", ""))):
                _error("Invalid record in " + collection, "storage")
            if row["id"] in ids:
                _error("Duplicate record id in " + collection)
            ids.add(row["id"])
            # Never trust locally edited or partially corrupted persistent data.
            incoming = {k: v for k, v in row.items() if k != "password_hash"}
            checked = _record(collection, incoming, existing=row)
            if collection == "users":
                encoded = checked.get("password_hash", "")
                if not isinstance(encoded, str) or not re.fullmatch(
                        r"pbkdf2_sha256\$260000\$[0-9a-f]{32}\$[0-9a-f]{64}", encoded):
                    _error("Invalid stored user credentials", "storage")
            if "name" in row:
                if row["name"] in names:
                    _error("Name already exists in " + collection)
                names.add(row["name"])
    server_ids = {row["id"] for row in tables["servers"]}
    server_profiles = {row["id"]: row for row in tables["server_profiles"]}
    user_profiles = {row["id"]: row for row in tables["user_profiles"]}
    interfaces = set()
    enabled_ports = set()
    for server in tables["servers"]:
        profile = server_profiles.get(server["profile"])
        if profile is None:
            _error("Server references a missing server profile", "reference")
        pool = ipaddress.ip_network(server["address_pool"])
        address = ipaddress.ip_address(profile["hotspot_address"])
        if address not in pool or address in (pool.network_address, pool.broadcast_address):
            _error("Hotspot address must be a usable address inside the server address pool")
        if not server["disabled"]:
            if server["interface"] in interfaces:
                _error("Only one enabled Hotspot server may use an interface")
            interfaces.add(server["interface"])
            if not profile["disabled"]:
                enabled_ports.add(profile["http_port"])
    if len(enabled_ports) > 1:
        _error("Enabled Hotspot servers must share one HTTP port")
    for user in tables["users"]:
        if user["profile"] not in user_profiles:
            _error("User references a missing user profile", "reference")
    for collection in ("users", "ip_bindings", "walled_garden", "walled_garden_ip"):
        for row in tables[collection]:
            if row["server"] != "all" and row["server"] not in server_ids:
                _error("%s references a missing server" % collection, "reference")


class UnavailableRuntime:
    def observe(self, config):
        return {"available": False, "error": "Hotspot network service is unavailable", "interfaces": [], "hosts": []}

    def configure(self, config, sessions):
        if any(not row["disabled"] for row in config["collections"]["servers"]):
            _error("Hotspot network service is unavailable", "runtime")


class Engine:
    def __init__(self, config_path="/etc/freeisp/hotspot.json",
                 state_path="/etc/freeisp/hotspot-state.json", runtime=None, clock=None):
        self.config_path = os.path.abspath(config_path)
        self.state_path = os.path.abspath(state_path)
        self.runtime = runtime or UnavailableRuntime()
        self.clock = clock or time.time
        with _LOCKS_GUARD:
            self._mutex = _LOCKS.setdefault(self.config_path, threading.RLock())
        self._last_checkpoint = 0
        self._attempts = {}
        self._last_observation = {"available": False, "error": "Not checked", "interfaces": [], "hosts": []}
        self.config = self._load_config()
        self.state = _read_json(self.state_path, {"schema": 1, "sessions": [], "cookies": [], "usage": {}})
        if self.state.get("schema") != 1 or not all(key in self.state for key in ("sessions", "cookies", "usage")):
            _error("Unsupported Hotspot session state", "storage")
        # Sessions never survive a daemon restart: firewall leases expire and
        # credentials/cookies must be presented again by a verified LAN peer.
        self.state["sessions"] = []

    def _load_config(self):
        config = _read_json(self.config_path, {"schema": 1, "revision": 0,
                                              "collections": {name: [] for name in COLLECTIONS}})
        _validate_config(config)
        return config

    @contextmanager
    def _locked(self):
        with self._mutex:
            directory = os.path.dirname(self.config_path)
            os.makedirs(directory, mode=0o700, exist_ok=True)
            with open(self.config_path + ".lock", "a+b") as lock:
                os.chmod(self.config_path + ".lock", 0o600)
                if fcntl:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    self.config = self._load_config()
                    yield
                finally:
                    if fcntl:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _checkpoint(self, force=False):
        now = self.clock()
        if force or now - self._last_checkpoint >= 30:
            _atomic_json(self.state_path, self.state)
            self._last_checkpoint = now

    def _tables(self, config=None):
        return (config or self.config)["collections"]

    def _lookup(self, collection, identity, config=None):
        return next((row for row in self._tables(config)[collection] if row["id"] == identity), None)

    def _revision(self, payload):
        if type(payload.get("revision")) is not int or payload["revision"] != self.config["revision"]:
            _error("Configuration changed. Refresh and retry your edit.", "conflict")

    def _runtime_configure(self, config=None, sessions=None):
        try:
            result = self.runtime.configure(config or self.config,
                                            self.state["sessions"] if sessions is None else sessions)
            if isinstance(result, dict) and result.get("ok") is False:
                _error(str(result.get("error", "Network configuration failed")), "runtime")
        except HotspotError:
            raise
        except Exception as exc:
            raise HotspotError("runtime", "Network configuration failed: %s" % exc) from exc

    def _valid_session(self, session, config=None):
        user = self._lookup("users", session["user_id"], config)
        server = self._lookup("servers", session["server"], config)
        if not user or not server or user["disabled"] or server["disabled"]:
            return False
        profile = self._lookup("user_profiles", user["profile"], config)
        server_profile = self._lookup("server_profiles", server["profile"], config)
        if not profile or not server_profile or profile["disabled"] or server_profile["disabled"]:
            return False
        if user["server"] not in ("all", server["id"]):
            return False
        if user["mac_address"] and user["mac_address"] != session["mac_address"]:
            return False
        if ipaddress.ip_address(session["address"]) not in ipaddress.ip_network(server["address_pool"]):
            return False
        if self._binding(session["address"], session["mac_address"], server["id"], config) == "blocked":
            return False
        now = self.clock()
        if profile["session_timeout"] and now - session["started_at"] >= profile["session_timeout"]:
            return False
        if profile["idle_timeout"] and now - session["last_activity"] >= profile["idle_timeout"]:
            return False
        usage = self.state["usage"].get(user["id"], {})
        for limit, total in (("limit_uptime", "uptime"), ("limit_bytes_in", "bytes_in"), ("limit_bytes_out", "bytes_out")):
            if user[limit] and usage.get(total, 0) >= user[limit]:
                return False
        return True

    def _binding(self, address, mac, server, config=None):
        matches = []
        for row in self._tables(config)["ip_bindings"]:
            if row["disabled"] or row["server"] not in ("all", server):
                continue
            if row["mac_address"] and row["mac_address"] != mac:
                continue
            if row["address"] and ipaddress.ip_address(address) not in ipaddress.ip_network(row["address"]):
                continue
            matches.append(row["type"])
        if "blocked" in matches:
            return "blocked"
        return "regular" if "regular" in matches else ("bypassed" if "bypassed" in matches else "regular")

    def _prune_sessions(self, config=None, revoked_users=()):
        """Apply tightened account and device limits immediately, oldest first."""
        kept, users, devices = [], {}, {}
        for session in sorted(self.state["sessions"], key=lambda row: row["started_at"]):
            if session["user_id"] in revoked_users or not self._valid_session(session, config):
                continue
            user = self._lookup("users", session["user_id"], config)
            profile = self._lookup("user_profiles", user["profile"], config)
            server = self._lookup("servers", session["server"], config)
            device = (server["id"], session["mac_address"])
            if users.get(user["id"], 0) >= profile["shared_users"] or devices.get(device, 0) >= server["addresses_per_mac"]:
                continue
            users[user["id"]] = users.get(user["id"], 0) + 1
            devices[device] = devices.get(device, 0) + 1
            kept.append(session)
        return kept

    def _refresh(self, configure=False):
        try:
            observation = self.runtime.observe(self.config)
            if not isinstance(observation, dict):
                raise ValueError("Invalid network observation")
            self._last_observation = observation
        except Exception as exc:
            self._last_observation = {"available": False, "error": str(exc), "interfaces": [], "hosts": []}
        now = self.clock()
        counters = self._last_observation.get("counters", {})
        for session in self.state["sessions"]:
            usage = self.state["usage"].setdefault(session["user_id"], {"uptime": 0, "bytes_in": 0, "bytes_out": 0})
            elapsed = max(0, now - session.get("accounted_at", now))
            usage["uptime"] += elapsed
            session["accounted_at"] = now
            observed = counters.get(session["id"], {})
            changed = False
            for field in ("bytes_in", "bytes_out"):
                value = observed.get(field)
                if type(value) in (int, float) and value >= 0:
                    previous = session.get("counter_" + field, 0)
                    delta = max(0, value - previous) if value >= previous else value
                    session["counter_" + field] = value
                    session[field] += delta
                    usage[field] += delta
                    changed |= delta > 0
            if changed:
                session["last_activity"] = now
        original = len(self.state["sessions"])
        self.state["sessions"] = self._prune_sessions()
        self.state["cookies"] = [cookie for cookie in self.state["cookies"] if self._valid_cookie(cookie)]
        if configure or len(self.state["sessions"]) != original:
            try:
                self._runtime_configure()
            except HotspotError as exc:
                self._last_observation["available"] = False
                self._last_observation["error"] = exc.message
                if configure:
                    raise
        self._checkpoint(force=len(self.state["sessions"]) != original)

    def poll(self):
        with self._locked():
            self._refresh(configure=True)

    def _public_session(self, session):
        return {"id": session["id"], "user": session["user"], "server": session["server"],
                "address": session["address"], "mac_address": session["mac_address"],
                "uptime": int(max(0, self.clock() - session["started_at"])),
                "bytes_in": int(session["bytes_in"]), "bytes_out": int(session["bytes_out"]),
                "started_at": session["started_at"], "last_activity": session["last_activity"]}

    def _snapshot(self):
        self._refresh()
        collections = copy.deepcopy(self._tables())
        for user in collections["users"]:
            user.pop("password_hash", None)
            user["password_set"] = True
            usage = self.state["usage"].get(user["id"], {})
            user["uptime"] = int(usage.get("uptime", 0))
            user["bytes_in"] = int(usage.get("bytes_in", 0))
            user["bytes_out"] = int(usage.get("bytes_out", 0))
        collections["active"] = [self._public_session(s) for s in self.state["sessions"]]
        collections["hosts"] = copy.deepcopy(self._last_observation.get("hosts", []))
        collections["cookies"] = [{k: c[k] for k in ("id", "user", "server", "mac_address", "expires_at")}
                                  for c in self.state["cookies"]]
        return {"ok": True, "revision": self.config["revision"], "collections": collections,
                "runtime": {"available": bool(self._last_observation.get("available")),
                            "error": self._last_observation.get("error", "")},
                "interfaces": copy.deepcopy(self._last_observation.get("interfaces", []))}

    def snapshot(self):
        with self._locked():
            return self._snapshot()

    def _ids(self, payload):
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > 10000 or any(not isinstance(x, str) for x in ids):
            _error("Select at least one record")
        if len(set(ids)) != len(ids):
            _error("Duplicate record selection")
        return set(ids)

    def _commit_config(self, candidate, revoked_users=None):
        _validate_config(candidate)
        old_config, old_state = self.config, copy.deepcopy(self.state)
        revoked_users = set(revoked_users or ())
        self.state["sessions"] = self._prune_sessions(candidate, revoked_users)
        self.config = candidate
        self.state["cookies"] = [c for c in self.state["cookies"]
                                 if c["user_id"] not in revoked_users and self._valid_cookie(c)]
        try:
            self._runtime_configure(candidate)
            _atomic_json(self.config_path, candidate)
            self._checkpoint(force=True)
        except Exception:
            self.config, self.state = old_config, old_state
            # A failure checkpointing session data must not leave the accepted
            # revision on disk while reporting the request as unsuccessful.
            try:
                _atomic_json(self.config_path, old_config)
                _atomic_json(self.state_path, old_state)
            except OSError:
                pass
            try:
                self._runtime_configure(old_config, old_state["sessions"])
            except Exception:
                pass  # Network adapter leases expire closed if recovery also fails.
            raise

    def dispatch(self, action, payload=None):
        payload = {} if payload is None else payload
        if not isinstance(payload, dict):
            _error("Request payload must be an object")
        with self._locked():
            if action == "snapshot":
                return self._snapshot()
            if action in ("disconnect", "remove_cookies"):
                ids = self._ids(payload)
                key = "sessions" if action == "disconnect" else "cookies"
                if not ids <= {row["id"] for row in self.state[key]}:
                    _error("Selected record no longer exists", "not_found")
                self._refresh()
                previous = copy.deepcopy(self.state)
                self.state[key] = [row for row in self.state[key] if row["id"] not in ids]
                try:
                    if key == "sessions":
                        self._runtime_configure()
                    self._checkpoint(force=True)
                except Exception:
                    self.state = previous
                    if key == "sessions":
                        try:
                            self._runtime_configure(sessions=previous["sessions"])
                        except Exception:
                            pass
                    raise
                return {"ok": True, "revision": self.config["revision"]}
            if action not in ("save", "remove", "set_enabled", "setup", "reset_html"):
                _error("Unknown Hotspot action", "unknown_action")
            self._revision(payload)
            if action == "reset_html":
                server = self._lookup("servers", payload.get("server_id"))
                if not server:
                    _error("Server no longer exists", "not_found")
                if not hasattr(self.runtime, "reset_html"):
                    _error("Portal template reset is unavailable", "runtime")
                try:
                    self.runtime.reset_html(server)
                except Exception as exc:
                    raise HotspotError("runtime", "Cannot reset portal template: %s" % exc) from exc
                return {"ok": True, "revision": self.config["revision"]}
            self._refresh()
            candidate = copy.deepcopy(self.config)
            candidate["revision"] += 1
            revoked = set()
            identity = None
            if action == "setup":
                identity = self._setup(candidate, payload)
            else:
                collection = payload.get("collection")
                if collection not in COLLECTIONS:
                    _error("Unknown editable collection")
                rows = candidate["collections"][collection]
                if action == "save":
                    incoming = payload.get("record")
                    if not isinstance(incoming, dict):
                        _error("Record must be an object")
                    existing = next((r for r in rows if r["id"] == incoming.get("id")), None)
                    if incoming.get("id") and not existing:
                        _error("Record no longer exists", "not_found")
                    saved = _record(collection, incoming, existing)
                    identity = saved["id"]
                    if existing:
                        rows[rows.index(existing)] = saved
                    else:
                        rows.append(saved)
                    if collection == "users" and incoming.get("password"):
                        revoked.add(identity)
                else:
                    ids = self._ids(payload)
                    if not ids <= {row["id"] for row in rows}:
                        _error("Selected record no longer exists", "not_found")
                    if action == "remove":
                        candidate["collections"][collection] = [r for r in rows if r["id"] not in ids]
                        if collection == "users":
                            revoked |= ids
                    else:
                        if type(payload.get("enabled")) is not bool:
                            _error("Enabled must be true or false")
                        for row in rows:
                            if row["id"] in ids:
                                row["disabled"] = not payload["enabled"]
            self._commit_config(candidate, revoked)
            return {"ok": True, "revision": candidate["revision"], "id": identity}

    def _setup(self, candidate, payload):
        name = _text(payload.get("name", "hotspot1"), "Name", 128, True)
        profile = _record("server_profiles", {"name": name + "-profile",
                          "hotspot_address": payload.get("local_address", ""),
                          "dns_name": payload.get("dns_name", ""),
                          "http_port": payload.get("http_port", 6480)})
        server = _record("servers", {"name": name, "interface": payload.get("interface", ""),
                         "address_pool": payload.get("address_pool", ""), "profile": profile["id"]})
        candidate["collections"]["server_profiles"].append(profile)
        candidate["collections"]["servers"].append(server)
        if not candidate["collections"]["user_profiles"]:
            candidate["collections"]["user_profiles"].append(_record("user_profiles", {"name": "default"}))
        return server["id"]

    def _valid_cookie(self, cookie):
        if cookie["expires_at"] <= self.clock():
            return False
        user = self._lookup("users", cookie["user_id"])
        server = self._lookup("servers", cookie["server"])
        if not user or not server or user["disabled"] or server["disabled"]:
            return False
        profile = self._lookup("server_profiles", server["profile"])
        user_profile = self._lookup("user_profiles", user["profile"])
        return bool(profile and user_profile and not profile["disabled"] and
                    not user_profile["disabled"] and profile["cookie_login"] and
                    user["server"] in ("all", server["id"]) and
                    (not user["mac_address"] or user["mac_address"] == cookie["mac_address"]))

    def _throttle(self, ip, failed=False):
        now = self.clock()
        self._attempts = {key: value for key, value in self._attempts.items() if value[-1] > now - 300}
        attempts = self._attempts.get(ip, [])
        if len(attempts) >= 10:
            _error("Too many login attempts. Try again in five minutes.", "rate_limited")
        if failed:
            self._attempts.setdefault(ip, []).append(now)

    def _authenticate_client(self, ip, mac, server_id):
        ip = _ipv4(ip, "Client address")
        mac = _mac(mac, required=True)
        server = self._lookup("servers", server_id)
        if not server or server["disabled"]:
            _error("Hotspot server is unavailable", "authentication")
        profile = self._lookup("server_profiles", server["profile"])
        if not profile or profile["disabled"]:
            _error("Hotspot server is unavailable", "authentication")
        if ipaddress.ip_address(ip) not in ipaddress.ip_network(server["address_pool"]):
            _error("Client is outside the Hotspot network", "authentication")
        if self._binding(ip, mac, server_id) == "blocked":
            _error("This device is blocked", "authentication")
        # The adapter verifies the peer against the current neighbor table;
        # callers cannot authorize an arbitrary address by posting form fields.
        if not hasattr(self.runtime, "client"):
            _error("Client verification is unavailable", "runtime")
        try:
            peer = self.runtime.client(ip)
        except Exception as exc:
            raise HotspotError("authentication", "Client could not be verified: %s" % exc) from exc
        if not isinstance(peer, dict) or peer.get("server_id", peer.get("server")) != server_id or _mac(peer.get("mac", peer.get("mac_address", "")), True) != mac:
            _error("Client does not match the active Hotspot host", "authentication")
        return ip, mac, server, profile

    def _create_session(self, user, ip, mac, server, server_profile, remember):
        if user["disabled"] or user["server"] not in ("all", server["id"]):
            _error("Invalid username or password", "authentication")
        if user["mac_address"] and user["mac_address"] != mac:
            _error("This account is assigned to another device", "authentication")
        profile = self._lookup("user_profiles", user["profile"])
        if not profile or profile["disabled"]:
            _error("Account profile is disabled", "authentication")
        # A successful re-login replaces only this exact peer's session.
        current = [s for s in self.state["sessions"] if not (s["server"] == server["id"] and s["address"] == ip)]
        if sum(s["user_id"] == user["id"] for s in current) >= profile["shared_users"]:
            _error("This account has reached its simultaneous login limit", "limit")
        if sum(s["server"] == server["id"] and s["mac_address"] == mac for s in current) >= server["addresses_per_mac"]:
            _error("This device has reached its address limit", "limit")
        now = self.clock()
        session = {"id": _identifier(), "user_id": user["id"], "user": user["name"],
                   "server": server["id"], "address": ip, "mac_address": mac,
                   "profile": user["profile"], "started_at": now, "last_activity": now,
                   "accounted_at": now, "bytes_in": 0, "bytes_out": 0,
                   "counter_bytes_in": 0, "counter_bytes_out": 0}
        if not self._valid_session(session):
            _error("This account has reached its usage limit", "limit")
        previous = copy.deepcopy(self.state)
        self.state["sessions"] = current + [session]
        cookie_token = None
        if remember and server_profile["cookie_login"]:
            cookie_token = secrets.token_urlsafe(32)
            self.state["cookies"] = [c for c in self.state["cookies"] if not
                                     (c["user_id"] == user["id"] and c["server"] == server["id"] and c["mac_address"] == mac)]
            self.state["cookies"].append({"id": _identifier(), "user_id": user["id"], "user": user["name"],
                                          "server": server["id"], "mac_address": mac,
                                          "expires_at": now + server_profile["cookie_lifetime"],
                                          "token_hash": hashlib.sha256(cookie_token.encode()).hexdigest()})
        try:
            self._runtime_configure()
            self._checkpoint(force=True)
        except Exception:
            self.state = previous
            try:
                self._runtime_configure(sessions=previous["sessions"])
            except Exception:
                pass
            raise
        self._attempts.pop(ip, None)
        return {"ok": True, "session": self._public_session(session), "cookie": cookie_token}

    def login(self, username, password, ip, mac, server_id, remember=False):
        with self._locked():
            self._throttle(ip)
            self._refresh()
            ip, mac, server, profile = self._authenticate_client(ip, mac, server_id)
            user = next((u for u in self._tables()["users"] if u["name"] == username), None)
            # Run a real PBKDF2 operation for unknown names as well.
            encoded = user["password_hash"] if user else "pbkdf2_sha256$260000$00000000000000000000000000000000$" + "0" * 64
            if not _password_matches(password, encoded) or not user:
                self._throttle(ip, failed=True)
                _error("Invalid username or password", "authentication")
            return self._create_session(user, ip, mac, server, profile, bool(remember))

    def login_cookie(self, token, ip, mac, server_id):
        with self._locked():
            self._throttle(ip)
            self._refresh()
            ip, mac, server, profile = self._authenticate_client(ip, mac, server_id)
            if not isinstance(token, str) or not 20 <= len(token) <= 200:
                _error("Login cookie is invalid or expired", "authentication")
            digest = hashlib.sha256(token.encode()).hexdigest()
            cookie = next((c for c in self.state["cookies"] if hmac.compare_digest(c["token_hash"], digest)
                           and c["server"] == server_id and c["mac_address"] == mac), None)
            if not cookie or not self._valid_cookie(cookie):
                self._throttle(ip, failed=True)
                _error("Login cookie is invalid or expired", "authentication")
            user = self._lookup("users", cookie["user_id"])
            return self._create_session(user, ip, mac, server, profile, False)

    def logout(self, session_id, ip=None):
        with self._locked():
            self._refresh()
            session = next((s for s in self.state["sessions"] if s["id"] == session_id), None)
            if not session or (ip is not None and session["address"] != ip):
                _error("Session does not belong to this client", "not_found")
            previous = copy.deepcopy(self.state)
            self.state["sessions"].remove(session)
            self.state["cookies"] = [c for c in self.state["cookies"] if not
                                     (c["user_id"] == session["user_id"] and c["server"] == session["server"]
                                      and c["mac_address"] == session["mac_address"])]
            try:
                self._runtime_configure()
                self._checkpoint(force=True)
            except Exception:
                self.state = previous
                try:
                    self._runtime_configure(sessions=previous["sessions"])
                except Exception:
                    pass
                raise
            return {"ok": True}
