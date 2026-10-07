import importlib.util
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "linux"))
from freeisp.config import DEFAULT, save_atomic, validate
from freeisp.agent import Controller


class FakeNetwork:
    def __init__(self):
        self.active = dict(DEFAULT)
        self.fail = False

    def apply(self, value):
        if self.fail and value["name"] == "Broken":
            raise RuntimeError("Simulated backend failure")
        self.active = dict(value)


class ConfigurationTests(unittest.TestCase):
    def test_rejects_command_injection_and_unknown_fields(self):
        for patch in ({"name": "test\nserver=evil"}, {"lan": "10.77.0.1/24;reboot"},
                      {"schema": True}, {"lease_minutes": True}, {"extra": "anything"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate(dict(DEFAULT, **patch))

    def test_rejects_overlap_gateway_and_invalid_pool(self):
        for patch in ({"pool_start": "10.77.0.1"}, {"pool_end": "10.77.0.255"},
                      {"pool_end": "10.77.0.10"}, {"lan": "10.0.2.1/24"},
                      {"lan": "10.78.0.1/24"}, {"lan": "8.8.8.1/24"},
                      {"lan": "10.77.0.0/24"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate(dict(DEFAULT, **patch))


@unittest.skipIf(sys.platform == "win32", "Durable directory fsync uses Linux semantics")
class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        save_atomic(self.path / "config.json", DEFAULT)
        self.network = FakeNetwork()
        self.c = Controller(self.network, self.path, timeout=0.1)

    def tearDown(self):
        self.c.revert()
        self.tmp.cleanup()

    def test_unconfirmed_change_rolls_back(self):
        self.c.stage(dict(DEFAULT, name="Temporary"))
        time.sleep(0.3)
        self.assertEqual(self.network.active, DEFAULT)
        self.assertEqual(json.loads((self.path / "config.json").read_text()), DEFAULT)

    def test_restart_loads_last_saved_not_pending(self):
        self.c.stage(dict(DEFAULT, name="Temporary"))
        restarted = Controller(FakeNetwork(), self.path)
        self.assertEqual(restarted.saved, DEFAULT)

    def test_confirm_persists_across_controller_restart(self):
        self.c.timeout = 5
        change = self.c.stage(dict(DEFAULT, name="Saved"))
        self.c.confirm(change["id"])
        self.assertEqual(Controller(FakeNetwork(), self.path).saved["name"], "Saved")

    def test_bad_token_and_concurrent_change_do_not_commit(self):
        self.c.timeout = 5
        self.c.stage(dict(DEFAULT, name="Pending"))
        with self.assertRaises(ValueError):
            self.c.confirm("wrong")
        with self.assertRaises(ValueError):
            self.c.stage(DEFAULT)
        self.assertEqual(json.loads((self.path / "config.json").read_text()), DEFAULT)

    def test_backend_failure_restores_previous_network(self):
        self.network.fail = True
        with self.assertRaises(RuntimeError):
            self.c.stage(dict(DEFAULT, name="Broken"))
        self.assertIsNone(self.c.pending)
        self.assertEqual(self.network.active, DEFAULT)


if __name__ == "__main__":
    unittest.main()
