"""Test the compiled native router-data transport against loopback HTTP fixtures.

Usage: python tools/desktop/test_router_data.py EXE --output artifacts/tests/router-data
No credentials or requests are logged. Only this process's loopback server is used.
"""
import argparse
import http.server
import json
from pathlib import Path
import re
import subprocess
import threading
import time

SESSION = '0123456789abcdef0123456789abcdef'  # synthetic local fixture token
DEVICE = {'eth0': {'type': 'Network device', 'up': True, 'mtu': 1500,
                  'statistics': {'rx_bytes': 987654, 'tx_bytes': 123456,
                                 'rx_packets': 111, 'tx_packets': 222},
                  'unexposed': 'must-not-cross-the-bridge'}}
state = {'scenario': '', 'calls': [], 'redirected': False}


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        state['redirected'] = True
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    def do_POST(self):
        scenario = state['scenario']
        try:
            request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
            state['calls'].append({
                'fixedEndpoint': self.path in ('/ubus', '/ubus/'),
                'fixedMethodAndSession': request == {'jsonrpc': '2.0', 'id': 1, 'method': 'call',
                    'params': [SESSION, 'network.device', 'status', {}]},
                'jsonContent': self.headers.get('Content-Type', '').startswith('application/json'),
                'noCookie': not self.headers.get('Cookie'),
            })
            if scenario == 'redirect':
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:%d/redirect-target' % self.server.server_port)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            reply = {'jsonrpc': '2.0', 'id': 1, 'result': [0, DEVICE]}
            if scenario == 'missing_statistics':
                reply['result'][1] = {'eth0': {'type': 'Network device', 'up': False}}
            elif scenario == 'denied_session':
                reply = {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32002, 'message': 'Access denied'}}
            elif scenario == 'wrong_id':
                reply['id'] = 99
            elif scenario == 'wrong_version':
                reply['jsonrpc'] = '1.0'
            elif scenario == 'error_with_result':
                reply['error'] = {'code': -32002, 'message': 'Access denied'}
            elif scenario == 'too_many_devices':
                reply['result'][1] = {'device%d' % i: DEVICE['eth0'] for i in range(513)}
            body = json.dumps(reply).encode()
            if scenario == 'invalid_json':
                body = b'{not JSON'
            if scenario == 'oversized':
                body = b' ' * (2 * 1024 * 1024 + 1) + body
            if scenario == 'slow_headers':
                time.sleep(7)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if scenario in ('slow_body', 'cancel_body'):
                self.wfile.write(body[:1])
                self.wfile.flush()
                time.sleep(7)
                self.wfile.write(body[1:])
            else:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Native cancellation deliberately closes these responses.


RUNNER = r'''
param([string]$Executable, [string]$Address, [string]$Token, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = 4194304
$assembly = [Reflection.Assembly]::LoadFile($Executable)
$type = $assembly.GetType('FreeISP.Desk.RouterDataClient', $true)
$flags = [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic
$constructor = $type.GetConstructor($flags, $null, [Type[]]@([Uri], [string]), $null)
$client = $constructor.Invoke([object[]]@([Uri]$Address, $Token))
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = @{success = $false; elapsed = 0; error = ''; sample = $null; cancelReturned = $false}
try {
    $task = $type.GetMethod('Interfaces', $flags).Invoke($client, $null)
    if ($Cancel) {
        [Threading.Thread]::Sleep(500)
        $type.GetMethod('Cancel', $flags).Invoke($client, $null) | Out-Null
        $result.cancelReturned = $true
    }
    while (-not $task.IsCompleted -and $clock.Elapsed.TotalSeconds -lt 9) {
        [Threading.Thread]::Sleep(10)
    }
    if (-not $task.IsCompleted) { throw 'Native transport exceeded the test deadline.' }
    $result.sample = $task.GetAwaiter().GetResult()
    $result.success = $true
} catch {
    $errorValue = $_.Exception
    while ($null -ne $errorValue.InnerException) { $errorValue = $errorValue.InnerException }
    $result.error = $errorValue.GetType().Name + ': ' + $errorValue.Message
} finally {
    $result.elapsed = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    $client.Dispose()
}
$serializer.Serialize($result)
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    executable = args.executable.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=True)
    runner = args.output.resolve() / 'invoke-native-transport.ps1'
    runner.write_text(RUNNER, encoding='utf-8')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, outcomes = {}, {}
    scenarios = ['success', 'missing_statistics', 'denied_session', 'redirect', 'invalid_json',
                 'oversized', 'wrong_id', 'wrong_version', 'error_with_result',
                 'too_many_devices', 'slow_headers', 'slow_body', 'cancel_body']
    try:
        for scenario in scenarios:
            state.update(scenario=scenario, calls=[], redirected=False)
            command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                       '-File', str(runner), '-Executable', str(executable),
                       '-Address', 'http://127.0.0.1:%d' % server.server_port, '-Token', SESSION]
            if scenario == 'cancel_body':
                command.append('-Cancel')
            process = subprocess.run(command, capture_output=True, text=True, timeout=15,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            combined = process.stdout + process.stderr
            if SESSION in combined:
                raise AssertionError('Fixture session token appeared in transport output.')
            if process.returncode != 0:
                # Never print raw invocation errors which could include arguments.
                outcomes[scenario] = {'success': False, 'runnerFailed': True}
                checks[scenario] = False
                print(scenario + ': FAIL (reflection runner)', flush=True)
                continue
            result = json.loads(process.stdout.strip())
            checks[scenario + '_fixed_request'] = len(state['calls']) == 1 and all(state['calls'][0].values())
            passed = not result['success']
            if scenario == 'success':
                sample = result.get('sample') or {}
                device = sample.get('devices', {}).get('eth0', {})
                passed = (result['success'] and sample.get('schema') == 1 and sample.get('sampleTime', 0) > 0
                          and device.get('up') is True and device.get('mtu') == 1500
                          and device.get('statistics') == DEVICE['eth0']['statistics']
                          and 'unexposed' not in device)
            elif scenario == 'missing_statistics':
                device = (result.get('sample') or {}).get('devices', {}).get('eth0', {})
                passed = (result['success'] and device.get('up') is False and device.get('mtu') is None
                          and device.get('statistics') == dict.fromkeys(DEVICE['eth0']['statistics']))
            elif scenario == 'denied_session':
                passed = passed and bool(re.search(r'session|access|sign in', result.get('error', ''), re.I))
            elif scenario == 'redirect':
                passed = passed and not state['redirected']
            elif scenario in ('slow_headers', 'slow_body'):
                passed = passed and result['elapsed'] < 7
            elif scenario == 'cancel_body':
                passed = passed and result.get('cancelReturned') is True and result['elapsed'] < 2.5
            checks[scenario] = bool(passed)
            outcomes[scenario] = {'passed': bool(passed), 'elapsed': result.get('elapsed'),
                                  'nativeSucceeded': result['success'], 'error': result.get('error', ''),
                                  'cancelReturned': result.get('cancelReturned', False)}
            print(scenario + ': ' + ('PASS' if passed else 'FAIL') + ' (%.3fs)' % result['elapsed'], flush=True)
    finally:
        server.shutdown()
        server.server_close()
    report = {'passed': all(checks.values()), 'scope': 'compiled RouterDataClient; loopback fixture only',
              'checks': checks, 'scenarios': outcomes, 'secretsLogged': False}
    (args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Native router-data transport: ' + ('PASS' if report['passed'] else 'FAIL'), flush=True)
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
