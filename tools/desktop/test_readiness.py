"""Exercise actual native timeout, recovery and superseded-navigation handling."""
import argparse
import http.server
import json
from pathlib import Path
import shutil
import subprocess
import threading
import time

state = dict(repaired=False, assets=0, authenticatedHtml=0)


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        kind = 'application/json'
        if self.path.startswith('/luci-static/freeisp/release.json'):
            value = json.dumps({'revision': 'd' * 64})
        elif self.path == '/luci-static/freeisp/readiness.js':
            state['assets'] += 1
            kind = 'application/javascript'
            value = "window.fixtureLoaded=true;"
            if state['repaired']:
                value += "if(!location.search.includes('stuck=1'))document.querySelector('#view').innerHTML='<h2>Router ready</h2>';"
        elif self.path.startswith('/cgi-bin/luci/admin/freeisp'):
            state['authenticatedHtml'] += int('desk_fixture=kept' in self.headers.get('Cookie', ''))
            if 'slow=1' in self.path:
                time.sleep(4)
            kind = 'text/html'
            value = '<!doctype html><title>Readiness fixture</title><div id="view"><div class="spinning">Loading view…</div></div><script src="/luci-static/freeisp/readiness.js"></script>'
        elif self.path == '/fixture/repair':
            state['repaired'] = True
            value = '{}'
        elif self.path == '/fixture/stats':
            value = json.dumps(state)
        else:
            self.send_error(404)
            return
        body = value.encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # The native Hub action intentionally cancels the slow response.


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
        result = subprocess.run([str(executable.resolve()), '--readiness-test',
                                 '--test-router=http://127.0.0.1:%d' % server.server_port],
                                timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
        report = json.loads((args.output / 'readiness-test.json').read_text())
        print(json.dumps(report, indent=2))
        assert result.returncode == 0 and report['passed'], report
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
