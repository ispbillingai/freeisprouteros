"""Exercise OpenWrt through authenticated ubus and a separate customer VM.

Run as root on the staging host. Only private VM image files are mounted;
host networking is never modified. No credentials are included in the report.
"""
import gzip
import http.server
import json
import os
import shutil
import shlex
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
OUT = PROJECT / 'artifacts/releases/freeisp-openwrt'
PASSWORD = json.loads(Path(os.environ['FREEISP_CREDENTIALS']).read_text())['password']
checks = {}


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition:
        raise AssertionError(name)


class Router:
    def __init__(self, port, ssh_port=2224):
        self.url = f'http://127.0.0.1:{port}'
        self.sid = '0' * 32
        self.ssh_port = ssh_port
        self.hosts = tempfile.NamedTemporaryFile(prefix='freeisp-guest-hosts-', dir=OUT)

    def rpc(self, obj, method, args=None, required=True):
        request = urllib.request.Request(self.url + '/ubus', data=json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'call',
            'params': [self.sid, obj, method, args or {}]}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.load(response)
        result = value.get('result', [value.get('error', {}).get('code', -1)])
        if required and result[0] != 0:
            raise RuntimeError(f'{obj}.{method} failed: {result}')
        return result[1] if len(result) > 1 else result[0]

    def login(self):
        result = self.rpc('session', 'login', {'username': 'root', 'password': PASSWORD})
        self.sid = result['ubus_rpc_session']

    def ready(self):
        for _ in range(90):
            try:
                self.login()
                return
            except (OSError, ValueError, RuntimeError):
                time.sleep(2)
        raise RuntimeError('OpenWrt management did not become ready')

    def execute(self, command, params=None):
        value = self.execute_result(command, params)
        if value.get('code') != 0:
            raise RuntimeError(f'{command} failed: {value}')
        return value.get('stdout', '')

    def execute_result(self, command, params=None):
        # Password goes through an anonymous stdin pipe, never argv or the report.
        result = subprocess.run(['sshpass', '-d', '0', 'ssh', '-p', str(self.ssh_port),
            '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
            '-o', f'UserKnownHostsFile={self.hosts.name}', 'root@127.0.0.1',
            shlex.join([command] + (params or []))], input=PASSWORD+'\n', text=True,
            capture_output=True, timeout=65)
        return {'code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}

    def interface(self, name):
        return json.loads(self.execute('/bin/ubus', ['call', 'network.interface.' + name, 'status']))


class Witness(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'x' * (256 * 1024) if self.path == '/large' else b'FreeISP routed witness\n'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


router = Router(int(os.environ.get('WEB_PORT', '8890')))
client = None
witness = None
report = OUT / 'validation.json'
recovery_only = os.environ.get('FREEISP_VERIFY_RECOVERY_ONLY') == '1'
if recovery_only:
    previous = json.loads(report.read_text())
    assert previous['source_commit'] == (OUT / 'SOURCE_COMMIT').read_text().strip()
    assert previous['checks'].get('sqm_customer_download_is_shaped')
    assert previous['checks'].get('customer_cannot_access_maintenance_http')
    checks.update(previous['checks'])
    checks.pop('verification_complete', None)
try:
    router.ready()
    if not recovery_only:
        check('authenticated_openwrt_boot', True)
        anonymous = Router(int(os.environ.get('WEB_PORT', '8890')))
        denied = anonymous.rpc('system', 'board', required=False)
        check('anonymous_system_access_rejected', isinstance(denied, int) and denied != 0)
        rejected = anonymous.rpc('session', 'login', {'username': 'root', 'password': 'invalid-test-password'}, required=False)
        check('incorrect_password_rejected', isinstance(rejected, int) and rejected != 0)
        board = router.rpc('system', 'board')
        check('official_release_and_identity', board['release']['version'] == '25.12.5' and board['hostname'] == 'FreeISP')
        command_line = '/usr/bin/freeisp-command-line'
        def command_line_rpc(args):
            return router.rpc('file', 'exec', {'command': command_line, 'params': args})
        check('command_line_ipv4_routes', command_line_rpc(['routes4']).get('code') == 0)
        check('command_line_ipv6_routes', command_line_rpc(['routes6']).get('code') == 0)
        check('command_line_logs', command_line_rpc(['log']).get('code') == 0)
        check('command_line_loopback_ping', command_line_rpc(['ping', '127.0.0.1', '1']).get('code') == 0)
        check('command_line_invalid_input_rejected', command_line_rpc(['ping', '-f', '1']).get('code') == 2)
        wan = router.interface('wan')
        check('wan_dhcp_up', wan['up'] and wan['ipv4-address'][0]['address'] == '10.0.2.15')
        check('lan_bridge_up', router.interface('lan')['device'] == 'br-lan')
        packages = router.execute('/bin/sh', ['-c', 'apk info'])
        check('management_packages_installed', all(p in packages.splitlines() for p in ['luci-app-sqm', 'luci-app-nlbwmon', 'luci-app-commands', 'luci-proto-wireguard']))
        check('radius_not_installed', not any('radius' in p.lower() for p in packages.splitlines()))
        themes = router.execute('/sbin/uci', ['show', 'luci.themes'])
        check('freeisp_and_upstream_themes_selectable', all(t in themes for t in ['FreeISP=', 'FreeISPNight=', 'Bootstrap=', 'OpenWrt2020=']))
        try:
            urllib.request.urlopen('http://127.0.0.1:8891/cgi-bin/luci/', timeout=3)
            blocked = False
        except OSError:
            blocked = True
        check('wan_http_management_blocked', blocked)
        router.execute('/sbin/sysupgrade', ['-b', '/tmp/freeisp-test-backup.tar.gz'])
        check('configuration_backup_created', int(router.execute('/bin/sh', ['-c', 'wc -c < /tmp/freeisp-test-backup.tar.gz'])) > 0)

        # A separate VM receives DHCP through the router's virtual LAN socket.
        # It is provisioned with different LAN/maintenance subnets to avoid conflicts.
        with tempfile.TemporaryDirectory(prefix='freeisp-openwrt-client-', dir=OUT) as directory:
            directory = Path(directory)
            disk = directory / 'client.raw'
            with gzip.open(OUT / 'freeisp-openwrt-x86-64.img.gz', 'rb') as src, open(disk, 'wb') as dst:
                shutil.copyfileobj(src, dst)
            disk.chmod(0o600)
            with open(disk, 'rb') as stream:
                mbr = stream.read(512)
            assert mbr[510:512] == b'\x55\xaa'
            entry = mbr[462:478]  # Root filesystem is partition two of the pinned x86 image.
            assert entry[4] == 0x83
            offset = struct.unpack_from('<I', entry, 8)[0] * 512
            assert 0 < offset < disk.stat().st_size
            mount = directory / 'root'
            mount.mkdir()
            subprocess.run(['mount', '-o', f'loop,offset={offset}', str(disk), str(mount)], check=True)
            try:
                defaults = mount / 'etc/uci-defaults/99-freeisp'
                defaults.write_text(defaults.read_text().replace('10.77.0.1', '10.90.0.1').replace('10.78.0.15', '10.79.0.15'))
            finally:
                subprocess.run(['umount', str(mount)], check=True)
            accel = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
            log = open(OUT / 'client-test.log', 'w')
            client = subprocess.Popen(['qemu-system-x86_64', '-machine', 'q35', '-accel', accel,
                '-cpu', 'host' if accel == 'kvm' else 'max', '-m', '512', '-smp', '2',
                '-drive', f'file={disk},format=raw,if=virtio',
                '-netdev', 'socket,id=wan,connect=127.0.0.1:18878',
                '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
                '-netdev', 'user,id=lan,restrict=on',
                '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
                '-netdev', 'user,id=management,net=10.79.0.0/24,hostfwd=tcp:127.0.0.1:8892-10.79.0.15:80,hostfwd=tcp:127.0.0.1:2225-10.79.0.15:22,restrict=on',
                '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
                '-display', 'none', '-monitor', 'none', '-serial', 'stdio'], stdout=log, stderr=subprocess.STDOUT)
            try:
                customer = Router(8892, 2225)
                customer.ready()
                cwan = customer.interface('wan')
                addresses = [v['address'] for v in cwan.get('ipv4-address', [])]
                check('separate_customer_receives_dhcp', any(a.startswith('10.77.0.') for a in addresses))
                dns = customer.execute('/bin/sh', ['-c', 'nslookup freeisp.lan 10.77.0.1'])
                check('customer_dns_lookup', 'freeisp.lan' in dns and '10.77.0.1' in dns and 'NXDOMAIN' not in dns)
                witness = http.server.ThreadingHTTPServer(('127.0.0.1', 18091), Witness)
                threading.Thread(target=witness.serve_forever, daemon=True).start()
                check('real_customer_http_routing', customer.execute('/usr/bin/curl', ['-fsS', '--max-time', '10', 'http://10.0.2.2:18091/witness']) == 'FreeISP routed witness\n')
                isolated = customer.execute_result('/usr/bin/curl', ['-fsS', '--max-time', '3', 'http://10.78.0.15/'])
                check('customer_cannot_access_maintenance_http', isolated.get('code') != 0)
                # SQM shaping is measured, not just inferred from an installed package.
                router.execute('/bin/sh', ['-c', "uci set sqm.freeisp_test=queue; uci set sqm.freeisp_test.interface='eth0'; uci set sqm.freeisp_test.enabled='1'; uci set sqm.freeisp_test.download='1024'; uci set sqm.freeisp_test.upload='1024'; uci set sqm.freeisp_test.qdisc='cake'; uci set sqm.freeisp_test.script='piece_of_cake.qos'; uci set sqm.freeisp_test.linklayer='none'; uci commit sqm; /etc/init.d/sqm restart"])
                try:
                    check('sqm_kernel_queue_active', 'cake' in router.execute('/bin/sh', ['-c', 'tc qdisc show']))
                    measured = customer.execute('/usr/bin/curl', ['-fsS', '--max-time', '40', '-o', '/dev/null', '-w', '%{size_download} %{time_total}', 'http://10.0.2.2:18091/large']).split()
                    check('sqm_customer_download_is_shaped', int(measured[0]) == 262144 and float(measured[1]) >= 1.4)
                finally:
                    router.execute('/bin/sh', ['-c', 'uci delete sqm.freeisp_test; uci commit sqm; /etc/init.d/sqm restart'])
            finally:
                client.terminate()
                client.wait(timeout=20)
                log.close()
                client = None

    # Use OpenWrt's session-scoped apply/rollback, not our previous Python implementation.
    system = router.rpc('uci', 'get', {'config': 'system'})['values']
    section = next(k for k, v in system.items() if v['.type'] == 'system')
    router.rpc('uci', 'set', {'config': 'system', 'section': section, 'values': {'hostname': 'FreeISP-Rollback-Test'}})
    router.rpc('uci', 'apply', {'rollback': True, 'timeout': 60})
    for _ in range(15):
        time.sleep(2)
        if router.rpc('system', 'board')['hostname'] == 'FreeISP-Rollback-Test':
            break
    check('openwrt_temporary_change_applied', router.rpc('system', 'board')['hostname'] == 'FreeISP-Rollback-Test')
    for _ in range(60):
        time.sleep(2)
        if router.rpc('system', 'board')['hostname'] == 'FreeISP':
            break
    check('openwrt_unconfirmed_change_rolled_back', router.rpc('system', 'board')['hostname'] == 'FreeISP')
    check('verification_complete', True)
finally:
    if client is not None:
        client.terminate()
        client.wait(timeout=20)
    if witness:
        witness.shutdown()
    report.write_text(json.dumps({'status': 'passed' if checks.get('verification_complete') and all(checks.values()) else 'failed_or_incomplete',
        'checks': checks, 'recovery_retried': recovery_only, 'source_commit': (OUT / 'SOURCE_COMMIT').read_text().strip(),
        'not_tested': ['physical hardware', 'wireless', 'PPPoE server', 'hotspot', 'WireGuard tunnel', 'production capacity', 'firmware upgrade']}, indent=2)+'\n')
