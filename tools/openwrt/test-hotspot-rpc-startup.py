"""Keep per-request Hotspot RPC startup independent of the portal server."""
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest

LIBRARY = Path(__file__).resolve().parents[2] / "openwrt/files/usr/lib/freeisp"
sys.path.insert(0, str(LIBRARY))
from hotspot_rpc import METHODS, read_json


class BridgeStartupTests(unittest.TestCase):
    def test_rpc_list_skips_daemon_imports(self):
        script = """
import json, runpy, sys
sys.path.insert(0, sys.argv[1])
path = sys.argv[1] + '/hotspot_service.py'
sys.argv = [path, 'rpc', 'list']
try:
    runpy.run_path(path, run_name='__main__')
except SystemExit as result:
    assert result.code == 0
print(json.dumps([name for name in ('http.server', 'hotspot', 'hotspot_runtime') if name in sys.modules]), file=sys.stderr)
"""
        result = subprocess.run([sys.executable, "-X", "utf8", "-c", script, str(LIBRARY)], capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout), METHODS)
        self.assertEqual(json.loads(result.stderr), [])

    def test_chunked_request_does_not_wait_for_eof(self):
        class Stream:
            def __init__(self):
                self.parts = iter([b'{"a":', b'"hello"}'])
            def read1(self, count):
                return next(self.parts)  # Another read would block with rpcd.
        self.assertEqual(read_json(Stream()), {"a": "hello"})

    def test_malformed_and_oversized_requests_fail(self):
        for raw, limit in [(b'[]', 100), (b'{"x":1} junk', 100), (b'{"x":100}', 4), (b'{', 100)]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                read_json(io.BytesIO(raw), limit)


if __name__ == "__main__":
    unittest.main()
