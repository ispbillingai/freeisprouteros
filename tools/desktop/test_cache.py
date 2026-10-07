"""Exercise the actual Windows WebView cache with a loopback-only router fixture."""
import argparse
import http.server
import json
from pathlib import Path
import shutil
import subprocess
import threading

state = dict(revision='a' * 64, version='A', assets=0, api=0, html=0, manifests=0, postIntact=False)


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        state['postIntact'] = self.rfile.read(int(self.headers['Content-Length'])) == b'probe=preserved'
        self.do_GET()

    def log_message(self, *args):
        pass

    def do_GET(self):
        kind = 'application/json'
        if self.path.startswith('/luci-static/freeisp/release.json'):
            state['manifests'] += 1
            value = json.dumps({'revision': state['revision']})
        elif self.path == '/luci-static/freeisp/test.js':
            state['assets'] += 1
            kind = 'application/javascript'
            value = "window.assetVersion=%s;fetch('/ubus').then(r=>r.json()).then(d=>window.apiValue=d.api);" % json.dumps(state['version'])
        elif self.path.startswith('/cgi-bin/luci/admin/freeisp'):
            state['html'] += 1
            kind = 'text/html'
            value = '<!doctype html><title>Local fixture</title><h2>Management fixture</h2><script src="/luci-static/freeisp/test.js"></script>'
        elif self.path == '/ubus':
            state['api'] += 1
            value = json.dumps({'api': state['api']})
        elif self.path == '/fixture/stats':
            value = json.dumps(state)
        elif self.path.startswith('/fixture/revision?stage=2'):
            state.update(revision='b' * 64, version='B')
            value = '{}'
        elif self.path.startswith('/fixture/revision?stage=3'):
            state.update(revision='invalid-manifest', version='C')
            value = '{}'
        else:
            self.send_error(404)
            return
        body = value.encode()
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    executable = args.output / 'FreeISP-Desk.exe'
    shutil.copy2(args.executable, executable)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        subprocess.run([str(executable.resolve()), '--cache-test',
                        '--test-router=http://127.0.0.1:%d' % server.server_port],
                       check=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
        report = json.loads((args.output / 'cache-test.json').read_text())
        print(json.dumps(report, indent=2))
        assert report['passed'], report
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
