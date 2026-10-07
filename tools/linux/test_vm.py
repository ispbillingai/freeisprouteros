"""Boot router and customer VMs; exercise packets, auth and persisted recovery."""
import datetime
import hashlib
import http.cookiejar
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
OUT = PROJECT / 'artifacts/releases/freeisp-linux-lab'
CACHE = PROJECT / 'artifacts/linux-cache'
REPORT = PROJECT / 'reports/linux-vm-validation.json'
checks = {}
processes = []
logs = []
context = ssl._create_unverified_context()  # Dedicated self-signed lab endpoint.


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition:
        raise AssertionError(name)


def boot():
    stream = open(CACHE / 'router-test.log', 'w')
    logs.append(stream)
    p = subprocess.Popen(['sh', './run.sh'], cwd=OUT, stdout=stream, stderr=subprocess.STDOUT)
    processes.append(p)
    for _ in range(120):
        time.sleep(1)
        text = (CACHE / 'router-test.log').read_text(errors='replace')
        if 'FREEISP_READY' in text:
            return p
        if p.poll() is not None or 'FREEISP_FATAL' in text:
            raise RuntimeError(text[-4000:])
    raise RuntimeError('Router boot timeout: ' + text[-4000:])


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=8)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()


def session():
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                      urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, path, data=None, headers=None):
    opts = {'Content-Type': 'application/json', 'X-FreeISP-Request': '1'}
    opts.update(headers or {})
    req = urllib.request.Request('https://127.0.0.1:8843' + path,
                                 data=None if data is None else json.dumps(data).encode(), headers=opts)
    try:
        response = opener.open(req, timeout=15)
        return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class Witness(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'FreeISP upstream witness\n'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = None
try:
    p = boot()
    check('linux_boot', True)
    anonymous = session()
    check('management_requires_login', request(anonymous, '/api/status')[0] == 401)
    check('backup_requires_login', request(anonymous, '/api/backup')[0] == 401)
    check('restore_requires_login', request(anonymous, '/api/restore', {})[0] == 401)
    check('wrong_password_rejected', request(anonymous, '/api/login', {'password': 'incorrect'})[0] == 401)
    auth = session()
    password = json.loads((OUT / 'credentials.json').read_text())['password']
    check('administrator_login', request(auth, '/api/login', {'password': password})[0] == 200)
    check('cross_origin_mutation_rejected', request(auth, '/api/revert', {}, {'Origin': 'https://elsewhere.invalid'})[0] == 403)
    code, status = request(auth, '/api/status')
    check('dhcp_dns_process_live', code == 200 and status['observed']['dhcp_dns_running'])
    check('wan_dhcp_address_and_route', any(r['dst'] == 'default' and r.get('gateway') == '10.0.2.2' for r in status['observed']['routes']))
    original = request(auth, '/api/backup')[1]
    check('invalid_backup_rejected', request(auth, '/api/restore', dict(original, name='bad\nconfig'))[0] == 400)
    try:
        urllib.request.urlopen('https://127.0.0.1:8844/', context=context, timeout=3)
        blocked = False
    except (urllib.error.URLError, TimeoutError):
        blocked = True
    check('wan_cannot_access_management', blocked)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 18090), Witness)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client_log = open(CACHE / 'client-test.log', 'w')
    logs.append(client_log)
    accel = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
    client = subprocess.Popen(['qemu-system-x86_64', '-machine', 'q35', '-accel', accel,
                               '-cpu', 'host' if accel == 'kvm' else 'max', '-m', '384',
                               '-kernel', str(OUT / 'vmlinuz'), '-initrd', str(OUT / 'initramfs.gz'),
                               '-append', 'console=ttyS0 rdinit=/init panic=0 freeisp.client=1',
                               '-netdev', 'socket,id=customer,connect=127.0.0.1:18877',
                               '-device', 'virtio-net-pci,netdev=customer,mac=52:54:00:f1:10:01',
                               '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot'],
                              stdout=client_log, stderr=subprocess.STDOUT)
    processes.append(client)
    client.wait(timeout=120)
    text = (CACHE / 'client-test.log').read_text(errors='replace')
    result = next((line.split('=', 1)[1] for line in text.splitlines() if line.startswith('FREEISP_CLIENT_RESULT=')), None)
    if result is None:
        raise RuntimeError(text[-4000:])
    packet_checks = json.loads(result)
    if 'error' in packet_checks:
        raise RuntimeError(packet_checks['error'] + '\n' + text[-2000:])
    for key, value in packet_checks.items():
        check(key, value)
    _, status = request(auth, '/api/status')
    import re
    check('kernel_nat_counter_nonzero', bool(re.search(r'counter packets [1-9][0-9]* bytes [0-9]+ masquerade', status['observed']['firewall'])))

    code, staged = request(auth, '/api/config', dict(original, name='Temporary lab change'))
    check('configuration_staged', code == 200)
    check('unconfirmed_backup_stays_saved', request(auth, '/api/backup')[1] == original)
    check('wrong_confirmation_rejected', request(auth, '/api/confirm', {'id': 'wrong'})[0] == 400)
    print('Waiting for the actual 60-second automatic configuration restore...', flush=True)
    for _ in range(65):
        time.sleep(1)
        _, s = request(auth, '/api/status')
        if not s['pending']:
            break
    check('actual_timeout_reverts_configuration', s['config'] == original and s['pending'] is None and s['error'] is None)
    changed = dict(original, name='FreeISP persistence test')
    code, staged = request(auth, '/api/config', changed)
    check('confirmation_saves', code == 200 and request(auth, '/api/confirm', {'id': staged['pending']['id']})[0] == 200)
    request(auth, '/api/config', dict(original, name='Unconfirmed before restart'))
    stop(p)
    p = boot()
    auth = session()
    request(auth, '/api/login', {'password': password})
    _, s = request(auth, '/api/status')
    check('restart_keeps_confirmed_discards_pending', s['config'] == changed and s['pending'] is None)
    code, staged = request(auth, '/api/restore', original)
    check('backup_restore_and_confirm', code == 200 and request(auth, '/api/confirm', {'id': staged['pending']['id']})[0] == 200)
    check('restored_backup_matches', request(auth, '/api/backup')[1] == original)
    check('logout_invalidates_session', request(auth, '/api/logout', {})[0] == 200 and request(auth, '/api/status')[0] == 401)
finally:
    for p in reversed(processes):
        if p.poll() is None:
            stop(p)
    if server:
        server.shutdown()
    for log in logs:
        log.close()
    REPORT.write_text(json.dumps({'generated_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'passed' if checks and all(checks.values()) and checks.get('logout_invalidates_session') else 'failed_or_incomplete',
        'checks': checks,
        'image_sha256': hashlib.sha256((OUT / 'initramfs.gz').read_bytes()).hexdigest(),
        'kernel_sha256': hashlib.sha256((OUT / 'vmlinuz').read_bytes()).hexdigest(),
        'scope': 'Actual Linux router VM and separate DHCP client VM, real routed packets, HTTPS API and state disk restart.',
        'not_tested': ['physical hardware', 'Wi-Fi', 'production load', 'PPPoE', 'hotspot', 'RADIUS', 'system image updates']}, indent=2) + '\n')
