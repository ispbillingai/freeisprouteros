"""Disposable local OpenWrt VLAN integration test; never connects to a VPS.

Requires Linux root, QEMU, openssl, and a FreeISP ext4 factory image at
artifacts/tests/interfaces-vm/base.img.gz. Only copies of that image are mounted.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/tests/interfaces-vm'
OUT.mkdir(parents=True, exist_ok=True)
PASSWORD = secrets.token_urlsafe(24)
checks = {}
processes = []
logs = []
TMP = Path(tempfile.mkdtemp(prefix='freeisp-interfaces-'))


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition:
        raise AssertionError(name)


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for(predicate, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(1)
    return False


class Router:
    def __init__(self, web_port, ssh_port):
        self.url = f'http://127.0.0.1:{web_port}'
        self.sid = '0' * 32
        self.ssh_port = ssh_port

    def rpc(self, obj, method, args=None):
        request = urllib.request.Request(self.url + '/ubus', data=json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'call',
            'params': [self.sid, obj, method, args or {}]}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.load(response)
        if 'result' not in payload:
            raise RuntimeError(f'{obj}.{method}: {payload.get("error", "missing result")}')
        result = payload['result']
        if result[0] != 0:
            raise RuntimeError(f'{obj}.{method} returned {result[0]}')
        return result[1] if len(result) > 1 else {}

    def ready(self):
        self.sid = '0' * 32
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            try:
                self.sid = self.rpc('session', 'login', {'username': 'root', 'password': PASSWORD})['ubus_rpc_session']
                return
            except (OSError, ValueError, RuntimeError, KeyError):
                time.sleep(1)
        raise RuntimeError('Local guest management did not become ready')

    def execute(self, command, params, input_text=''):
        password_read, password_write = os.pipe()
        os.write(password_write, (PASSWORD + '\n').encode())
        os.close(password_write)
        try:
            run = subprocess.run(['sshpass', '-d', str(password_read), 'ssh', '-p', str(self.ssh_port),
                '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
                '-o', f'UserKnownHostsFile={TMP / (str(self.ssh_port) + ".hosts")}', 'root@127.0.0.1',
                shlex.join([command] + params)], input=input_text, text=True, capture_output=True,
                timeout=45, pass_fds=(password_read,))
            return {'code': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr}
        finally:
            os.close(password_read)

    def refresh_view(self):
        for name in ['resources/view/freeisp/interfaces.js', 'resources/freeisp/interfaces-data.js', 'resources/freeisp/interfaces.css']:
            content = (ROOT / 'openwrt/files/www/luci-static' / name).read_bytes().decode()
            result = self.execute('/bin/sh', ['-c', 'cat > ' + shlex.quote('/www/luci-static/' + name)], content)
            if result['code']:
                raise RuntimeError('Updating disposable guest view failed')

    def config(self, name):
        return self.rpc('uci', 'get', {'config': name})['values']

    def interface(self, name):
        return next((s for s in self.rpc('network.interface', 'dump')['interface'] if s['interface'] == name), {})

    def add(self, kind, values, name=None):
        args = {'config': 'network', 'type': kind, 'values': values}
        if name:
            args['name'] = name
        return self.rpc('uci', 'add', args)['section']

    def set(self, section, values):
        self.rpc('uci', 'set', {'config': 'network', 'section': section, 'values': values})

    def apply(self):
        self.rpc('uci', 'apply', {'rollback': True, 'timeout': 30})
        time.sleep(3)
        self.rpc('uci', 'confirm')

    def ping(self, address):
        result = self.execute('/bin/ping', ['-c', '2', '-W', '2', address])
        if result['code'] not in (0, 1):
            raise RuntimeError('Packet witness SSH/command failed: ' + result['stderr'])
        return result['code'] == 0


def prepare(name):
    disk = TMP / (name + '.raw')
    with gzip.open(OUT / 'base.img.gz', 'rb') as src, disk.open('wb') as dst:
        shutil.copyfileobj(src, dst)
    disk.chmod(0o600)
    with disk.open('rb') as stream:
        mbr = stream.read(512)
    assert mbr[510:512] == b'\x55\xaa'
    offset = struct.unpack_from('<I', mbr[462:478], 8)[0] * 512
    assert 0 < offset < disk.stat().st_size
    mount = TMP / ('mount-' + name)
    mount.mkdir(exist_ok=True)
    subprocess.run(['mount', '-o', f'loop,offset={offset}', str(disk), str(mount)], check=True)
    try:
        shutil.copytree(ROOT / 'openwrt/files', mount, dirs_exist_ok=True)
        # A Windows checkout can use CRLF for extensionless shell scripts.
        for script in list((mount / 'etc/uci-defaults').glob('*')) + [mount / 'usr/bin/freeisp-resources']:
            if script.is_file():
                script.write_bytes(script.read_bytes().replace(b'\r\n', b'\n'))
        seed = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=PASSWORD + '\n', text=True, capture_output=True, check=True).stdout
        (mount / 'etc/freeisp').mkdir(exist_ok=True)
        (mount / 'etc/freeisp/root.hash').write_text(seed)
        # On an already personalized image, force only the copied factory defaults
        # to run again; all modifications remain inside this disposable disk.
        (mount / 'etc/uci-defaults/99-freeisp').chmod(0o755)
    finally:
        subprocess.run(['umount', str(mount)], check=True)
    return disk


def boot(name, disk, web_port, ssh_port, cable_port, witness=False):
    logfile = (OUT / (name + '.log')).open('w')
    logs.append(logfile)
    wan = f'socket,id=wan,connect=127.0.0.1:{cable_port}' if witness else 'user,id=wan,restrict=on'
    lan = 'user,id=lan,restrict=on' if witness else f'socket,id=lan,listen=127.0.0.1:{cable_port}'
    process = subprocess.Popen(['qemu-system-x86_64', '-machine', 'q35', '-accel', 'tcg', '-cpu', 'qemu64', '-m', '512', '-smp', '1',
        '-drive', f'file={disk},format=raw,if=virtio',
        '-netdev', wan, '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
        '-netdev', lan, '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
        '-netdev', f'user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:{web_port}-10.78.0.15:80,hostfwd=tcp:127.0.0.1:{ssh_port}-10.78.0.15:22,restrict=on',
        '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
        '-display', 'none', '-monitor', 'none', '-serial', 'stdio'], stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT)
    processes.append(process)
    return process


try:
    for marker in ['ui-done', 'ui-result.json', 'local-session.json']:
        (OUT / marker).unlink(missing_ok=True)
    router_port, witness_port, router_ssh, witness_ssh, cable = port(), port(), port(), port(), port()
    router_disk, witness_disk = prepare('router'), prepare('witness')
    print('Prepared disposable images on local Linux storage; booting router', flush=True)
    boot('router', router_disk, router_port, router_ssh, cable)
    time.sleep(2)
    boot('witness', witness_disk, witness_port, witness_ssh, cable, True)
    router = Router(router_port, router_ssh)
    router.ready()
    check('local_openwrt_boot', router.rpc('system', 'board')['release']['distribution'] == 'OpenWrt')
    witness = Router(witness_port, witness_ssh)
    witness.ready()
    check('separate_local_witness_boot', True)
    before = router.config('network')
    firewall, dhcp = router.config('firewall'), router.config('dhcp')
    for filename in ['resources/view/freeisp/interfaces.js', 'resources/freeisp/interfaces-data.js', 'resources/freeisp/interfaces.css']:
        with urllib.request.urlopen(router.url + '/luci-static/' + filename, timeout=15) as response:
            actual = response.read()
        check('served_' + Path(filename).name, hashlib.sha256(actual).digest() == hashlib.sha256((ROOT / 'openwrt/files/www/luci-static' / filename).read_bytes()).digest())
    check('metadata_rpc', 'eth1' in router.rpc('luci-rpc', 'getNetworkDevices'))
    check('wan_still_up', router.interface('wan').get('up'))
    check('lan_still_bridged', router.interface('lan').get('device') == 'br-lan')
    if os.environ.get('FREEISP_TEST_WAIT_UI') == '1':
        session = OUT / 'local-session.json'
        session.write_text(json.dumps({'url': router.url, 'username': 'root', 'password': PASSWORD}))
        session.chmod(0o600)
        print('LOCAL_BROWSER_READY', flush=True)
        for _ in range(1800):
            if (OUT / 'ui-done').exists():
                if json.loads((OUT / 'ui-result.json').read_text())['passed']:
                    break
                print('Local browser check needs a retry; keeping disposable guests available', flush=True)
                (OUT / 'ui-done').unlink()
                router.refresh_view()
            time.sleep(1)
        else:
            raise RuntimeError('Local browser handoff timed out')
        check('live_browser_actions', json.loads((OUT / 'ui-result.json').read_text())['passed'])
    tag = router.add('device', {'name': 'test-vlan', 'type': '8021q', 'ifname': 'eth1', 'vid': '30', 'mtu': '1400'})
    router.add('interface', {'device': 'test-vlan', 'proto': 'static', 'ipaddr': '192.0.2.1', 'netmask': '255.255.255.0'}, 'vlantest')
    # Allow only the disposable test network through the existing LAN zone.
    zone = next(k for k, s in firewall.items() if s.get('.type') == 'zone' and s.get('name') == 'lan')
    original_networks = firewall[zone].get('network', [])
    if isinstance(original_networks, str):
        original_networks = original_networks.split()
    router.rpc('uci', 'set', {'config': 'firewall', 'section': zone, 'values': {'network': original_networks + ['vlantest']}})
    router.apply()
    peer_tag = witness.add('device', {'name': 'peer-vlan', 'type': '8021q', 'ifname': 'eth0', 'vid': '30', 'mtu': '1400'})
    witness.add('interface', {'device': 'peer-vlan', 'proto': 'static', 'ipaddr': '192.0.2.2', 'netmask': '255.255.255.0'}, 'vlantest')
    witness.apply()
    check('vlan_interface_up', wait_for(lambda: router.interface('vlantest').get('up')))
    check('witness_vlan_interface_up', wait_for(lambda: witness.interface('vlantest').get('up')))
    state = router.rpc('network.device', 'status', {'name': 'test-vlan'})
    check('vlan_id_parent_mtu_runtime', state.get('vid') == 30 and state.get('parent') == 'eth1' and state.get('mtu') == 1400)
    check('tagged_packets_between_guests', wait_for(lambda: witness.ping('192.0.2.1')))
    router.set(tag, {'vid': '31'})
    router.apply()
    check('edited_vlan_id_active', wait_for(lambda: router.rpc('network.device', 'status', {'name': 'test-vlan'}).get('vid') == 31))
    check('different_vlan_ids_isolate_traffic', not witness.ping('192.0.2.1'))
    witness.set(peer_tag, {'vid': '31'})
    witness.apply()
    check('edited_vlan_restores_tagged_traffic', wait_for(lambda: witness.ping('192.0.2.1')))
    router.set(tag, {'type': '8021ad'})
    router.apply()
    check('8021ad_protocol_active', wait_for(lambda: router.rpc('network.device', 'status', {'name': 'test-vlan'}).get('type') == '8021ad'))
    check('different_vlan_protocols_isolate_traffic', not witness.ping('192.0.2.1'))
    witness.set(peer_tag, {'type': '8021ad'})
    witness.apply()
    check('8021ad_tagged_packets_between_guests', wait_for(lambda: witness.ping('192.0.2.1')))
    router.set(tag, {'vid': '32'})
    router.rpc('uci', 'apply', {'rollback': True, 'timeout': 10})
    time.sleep(15)
    # rpcd keeps the rejected edit in the original session for review. Check
    # active state and read committed configuration through a fresh session.
    check('unconfirmed_vlan_change_rolls_back', wait_for(lambda: router.rpc('network.device', 'status', {'name': 'test-vlan'}).get('vid') == 31))
    router.ready()
    check('rollback_restores_committed_config', router.config('network')[tag]['vid'] == '31')
    check('traffic_restored_after_rollback', wait_for(lambda: witness.ping('192.0.2.1')))
    old_boot = router.execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])['stdout'].strip()
    check('boot_id_available', len(old_boot) == 36)
    router.execute('/sbin/reboot', [])

    def new_boot():
        try:
            result = router.execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])
            current = result['stdout'].strip()
            return result['code'] == 0 and len(current) == 36 and current != old_boot
        except subprocess.TimeoutExpired:
            return False

    check('guest_actually_rebooted', wait_for(new_boot, timeout=200))
    router.ready()
    check('vlan_settings_persist_after_reboot', router.config('network')[tag]['vid'] == '31')
    check('tagged_traffic_after_reboot', wait_for(lambda: witness.ping('192.0.2.1')))
    router.rpc('uci', 'delete', {'config': 'network', 'section': 'vlantest'})
    router.rpc('uci', 'delete', {'config': 'network', 'section': tag})
    router.rpc('uci', 'set', {'config': 'firewall', 'section': zone, 'values': {'network': original_networks}})
    router.apply()
    check('vlan_delete_persisted', tag not in router.config('network'))
    check('vlan_delete_active', wait_for(lambda: not router.interface('vlantest')))
    check('deleted_vlan_stops_traffic', not witness.ping('192.0.2.1'))
    after = router.config('network')
    check('original_network_sections_preserved', all(after.get(k) == v for k, v in before.items()))
    check('dhcp_unchanged', router.config('dhcp') == dhcp)
    check('firewall_restored', router.config('firewall') == firewall)
    check('management_and_wan_still_up', router.interface('management').get('up') and router.interface('wan').get('up'))
finally:
    if processes and not checks.get('management_and_wan_still_up') and 'router' in locals() and checks.get('local_openwrt_boot'):
        for name, guest in [('router', router), ('witness', locals().get('witness'))]:
            if guest is not None:
                try:
                    debug = guest.execute('/bin/sh', ['-c', 'uci show network; uci show firewall; ip -d link; ip -4 addr; ip -4 route; ip neigh; nft list chain inet fw4 input; logread -e netifd | tail -n 30'])
                    (OUT / (name + '-network-diagnostic.txt')).write_text(debug['stdout'] + debug['stderr'])
                except Exception:
                    pass
    for process in reversed(processes):
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    for log in logs:
        log.close()
    if not any(p.is_mount() for p in TMP.glob('mount-*')):
        shutil.rmtree(TMP)
    (OUT / 'local-session.json').unlink(missing_ok=True)
    (OUT / 'result.json').write_text(json.dumps({'passed': bool(checks.get('management_and_wan_still_up')) and all(checks.values()), 'checks': checks, 'environment': 'two disposable local QEMU OpenWrt guests; no VPS'}, indent=2) + '\n')
