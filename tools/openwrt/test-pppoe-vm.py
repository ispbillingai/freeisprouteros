"""Exercise two disposable OpenWrt guests; no commands target the deployed VPS."""
import io
import http.server
import crypt
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tarfile
import time
import threading
import urllib.request
from test_pppoe import fixture

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/pppoe-lab'
credentials = Path('/work/artifacts/releases/freeisp-openwrt-vps/CREDENTIALS.txt').read_text(encoding='utf-8-sig')
password = re.search(r'^Password:\s*(.+)$', credentials, re.M).group(1).strip()
checks = {}


class Witness(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        payload = b'FreeISP routed PPPoE witness\n' if self.path == '/' else b'x' * (2 * 1024 * 1024)
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers['Content-Length'])
        if length > 2 * 1024 * 1024:
            self.send_error(413)
            return
        received = self.rfile.read(length)
        self.send_response(200 if len(received) == length else 400)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *_):
        pass


witness = http.server.ThreadingHTTPServer(('127.0.0.1', 23978), Witness)
threading.Thread(target=witness.serve_forever, daemon=True).start()


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    report = 'browser-setup-results.json' if os.environ.get('FREEISP_PPPOE_BROWSER_ONLY') == '1' else 'results.json'
    (OUT / report).write_text(json.dumps(checks, indent=2))
    if not condition:
        raise AssertionError(name)


def ssh(port, command, data=None, timeout=30):
    read, write = os.pipe()
    os.write(write, (password + '\n').encode())
    os.close(write)
    try:
        result = subprocess.run(['sshpass', '-d', str(read), 'ssh', '-p', str(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=3',
                                 '-o', 'UserKnownHostsFile=' + str(OUT / 'known_hosts'), 'root@127.0.0.1', command],
                                input=data, capture_output=True, timeout=timeout, pass_fds=(read,))
    finally:
        os.close(read)
    if result.returncode:
        raise RuntimeError('Guest command failed: ' + result.stderr.decode()[-2000:])
    return result.stdout.decode()


def ready(port):
    last_error = None
    for _ in range(90):
        try:
            ssh(port, 'true')
            return
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError('Test guest did not start: ' + str(last_error))


def rpc(method, value=None):
    result = json.loads(ssh(23974, 'ubus call freeisp.pppoe ' + method + ' "$(cat)"', json.dumps(value or {}).encode()))
    return result


def http_rpc(sid, obj, method, args=None):
    request = urllib.request.Request('http://127.0.0.1:23976/ubus',
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'call', 'params': [sid, obj, method, args or {}]}).encode(),
        headers={'Content-Type': 'application/json'})
    response = json.load(urllib.request.urlopen(request, timeout=20))
    return response['result'] if 'result' in response else [response['error']['code']]


def wait_connection(expected=True):
    for _ in range(30):
        value = rpc('status')
        if bool(value.get('sessions')) == expected:
            return value
        time.sleep(1)
    print(ssh(23974, 'logread -e ppp | tail -35'), flush=True)
    print(ssh(23975, 'logread -e ppp | tail -20'), flush=True)
    raise RuntimeError('Subscriber connection did not reach expected state.')


ready(23974)
ready(23975)
check('isolated_guests_boot', True)
print('Installing official server and shaping packages in the test guest...', flush=True)
print(ssh(23974, 'apk update >/dev/null && apk add rp-pppoe-server python3 tc-full kmod-sched-core kmod-sched-act-police', timeout=180), flush=True)
files = [p for p in (ROOT / 'openwrt/files').rglob('*') if p.is_file() and ('pppoe' in p.name or p.name == 'freeisp-pppd')]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
    for path in files:
        name = str(path.relative_to(ROOT / 'openwrt/files'))
        tar.add(path, arcname=name)
ssh(23974, 'tar -xzf - -C /', buffer.getvalue())
ssh(23974, 'chmod 755 /usr/libexec/freeisp-* /usr/libexec/rpcd/freeisp.pppoe /etc/init.d/freeisp-pppoe /etc/uci-defaults/98-freeisp-pppoe; /etc/uci-defaults/98-freeisp-pppoe; /etc/init.d/firewall reload; /etc/init.d/freeisp-pppoe start; /etc/init.d/rpcd restart', timeout=45)
time.sleep(2)
value = rpc('get')
check('rpc_get_available', 'config' in value and value['status']['available'])
if os.environ.get('FREEISP_PPPOE_BROWSER_ONLY') == '1':
    cleared = rpc('save', {'config': {k: [] for k in ('pools', 'profiles', 'servers', 'secrets')}, 'revision': value['revision']})
    check('browser_fixture_reset', not cleared.get('error'))
    (OUT / 'browser-done').unlink(missing_ok=True)
    (OUT / 'browser-ready').write_text('ready')
    print('Local OpenWrt VM ready for the browser integration test.', flush=True)
    for _ in range(180):
        if (OUT / 'browser-done').exists():
            sys.exit(0)
        time.sleep(1)
    raise RuntimeError('Browser integration test did not finish within three minutes.')
check('anonymous_api_access_denied', http_rpc('0' * 32, 'freeisp.pppoe', 'get')[0] != 0)
hashed = crypt.crypt('local-readonly-test', crypt.mksalt(crypt.METHOD_SHA512))
ssh(23974, "uci set rpcd.pppoe_test_reader=login; uci set rpcd.pppoe_test_reader.username=pppoe-reader; uci set rpcd.pppoe_test_reader.password=" + shlex.quote(hashed) + "; uci -q delete rpcd.pppoe_test_reader.read; uci add_list rpcd.pppoe_test_reader.read=luci-app-freeisp-pppoe; uci commit rpcd; /etc/init.d/rpcd restart")
time.sleep(2)
login = http_rpc('0' * 32, 'session', 'login', {'username': 'pppoe-reader', 'password': 'local-readonly-test'})
check('readonly_login', login[0] == 0)
reader = login[1]['ubus_rpc_session']
check('readonly_get_allowed', http_rpc(reader, 'freeisp.pppoe', 'get')[0] == 0)
check('readonly_save_denied', http_rpc(reader, 'freeisp.pppoe', 'save', {'config': {}, 'revision': ''})[0] != 0)
check('readonly_disconnect_denied', http_rpc(reader, 'freeisp.pppoe', 'disconnect', {'id': '1'})[0] != 0)
value = rpc('get')
config = fixture()
value = rpc('save', {'config': config, 'revision': value['revision']})
if value.get('error'):
    print(value, flush=True)
    print(ssh(23974, 'logread | tail -30'), flush=True)
check('save_starts_real_server', not value.get('error') and value['status']['servers'][0]['running'])
check('password_not_returned', 'password' not in value['config']['secrets'][0])
check('private_configuration_permissions', ssh(23974, 'ls -l /etc/freeisp/pppoe.json').startswith('-rw-------'))
check('generated_pppd_options', 'chap-secrets' in ssh(23974, 'cat /var/run/freeisp-pppoe/generated/333333333333.options'))
# Configure only the disposable client's WAN; maintenance remains on NIC 3.
ssh(23975, "uci set network.wan.proto=pppoe; uci set network.wan.username=customer; uci set network.wan.password=local-test-only; uci set network.wan.service=internet; uci set network.wan.ipv6=0; uci commit network; ifdown wan; ifup wan")
connected = wait_connection()
session = connected['sessions'][0]
check('chap_authentication_and_pool_assignment', session['name'] == 'customer' and session['address'] == '10.80.0.10')
check('profile_rate_limits_installed', 'rate 2048Kbit' in ssh(23974, 'tc qdisc show dev ' + shlex.quote(session['interface'])))
check('subscriber_wan_routing_and_nat', 'FreeISP routed PPPoE witness' in ssh(23975, 'curl --interface pppoe-wan -fsS --max-time 15 http://10.0.2.2:23978/', timeout=20))
speed = float(ssh(23975, 'curl --interface pppoe-wan -fsS --max-time 40 -o /dev/null -w "%{speed_download}" http://10.0.2.2:23978/payload', timeout=45))
check('download_rate_enforced_on_real_traffic', 50000 < speed < 360000)
upload_speed = float(ssh(23975, 'head -c 1048576 /dev/zero | curl --interface pppoe-wan -fsS --max-time 60 --data-binary @- -o /dev/null -w "%{speed_upload}" http://10.0.2.2:23978/', timeout=65))
check('upload_rate_enforced_on_real_traffic', 5000 < upload_speed < 220000)
check('subscriber_cannot_reach_management', ssh(23975, 'curl --interface pppoe-wan -k -fsS --max-time 3 -o /dev/null https://10.80.0.1 && echo reachable || echo blocked', timeout=10).strip() == 'blocked')
check('live_counters', wait_connection()['sessions'][0]['rx_bytes'] > 0)
result = rpc('disconnect', {'id': session['id']})
check('disconnect_requested', result.get('disconnecting'))
time.sleep(2)
check('disconnected_session_identity_gone', not any(r['id'] == session['id'] for r in rpc('status')['sessions']))
ssh(23975, 'ifdown wan')
wait_connection(False)
ssh(23975, 'uci set network.wan.password=wrong-password; ifup wan')
time.sleep(8)
check('wrong_password_rejected', not rpc('status')['sessions'])
ssh(23975, 'ifdown wan')
current = rpc('get')
bad = json.loads(json.dumps(current['config']))
bad['pools'][0]['end'] = '10.80.0.1'
check('invalid_pool_rejected', bool(rpc('save', {'config': bad, 'revision': current['revision']}).get('error')))
check('invalid_save_preserves_config', rpc('get')['config'] == current['config'])
missing = json.loads(json.dumps(current['config']))
missing['servers'][0]['interface'] = 'missing0'
check('missing_server_device_rejected', bool(rpc('save', {'config': missing, 'revision': current['revision']}).get('error')))
check('stale_revision_rejected', bool(rpc('save', {'config': current['config'], 'revision': 'stale'}).get('error')))
check('unknown_disconnect_rejected', bool(rpc('disconnect', {'id': '9999-stale'}).get('error')))
# Reboot tests actual on-disk persistence and the init service's boot registration.
try:
    ssh(23974, 'reboot', timeout=10)
except Exception:
    pass
time.sleep(10)
ready(23974)
after = rpc('get')
for _ in range(20):
    if after['status']['servers'][0]['running']:
        break
    time.sleep(1)
    after = rpc('get')
check('settings_survive_reboot', after['config'] == current['config'])
check('server_starts_after_reboot', after['status']['servers'][0]['running'])
ssh(23975, 'uci set network.wan.password=local-test-only; ifup wan')
check('subscriber_reconnects_after_reboot', bool(wait_connection()['sessions']))
check('baseline_wan_lan_management_preserved', all(name in ssh(23974, 'ubus call network.interface dump') for name in ['"wan"', '"lan"', '"management"']))
current = rpc('get')
current['config']['secrets'][0]['enabled'] = False
disabled = rpc('save', {'config': current['config'], 'revision': current['revision']})
check('disable_secret_saved', not disabled.get('error') and not disabled['config']['secrets'][0]['enabled'])
wait_connection(False)
time.sleep(5)
check('disabled_account_cannot_reconnect', not rpc('status')['sessions'])
current = rpc('get')
current['config']['secrets'] = []
current['config']['servers'] = []
current['config']['profiles'] = []
current['config']['pools'] = []
removed = rpc('save', {'config': current['config'], 'revision': current['revision']})
check('delete_configuration_persists', not removed.get('error') and all(not rows for rows in rpc('get')['config'].values()))
print('PPPoE VM checks complete.', flush=True)
