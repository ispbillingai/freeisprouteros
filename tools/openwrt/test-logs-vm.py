"""Boot a disposable copy of an OpenWrt image and test real logd and ACLs.

Run as root on Linux: python3 tools/openwrt/test-logs-vm.py --image /private/image.img.gz
Use --hold to allow a browser to test the running guest; create STOP in the output
directory to finish. Only the copied guest disk is mounted/modified. No deployment.
The runtime credentials and VM outputs belong under ignored artifacts/.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import secrets
import shutil
import struct
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
parser.add_argument('--port', type=int, default=18890)
parser.add_argument('--bind', default='127.0.0.1')
parser.add_argument('--hold', action='store_true')
args = parser.parse_args()
project = Path(__file__).resolve().parents[2]
out = project / 'artifacts/tests/logs-vm'
out.mkdir(parents=True, exist_ok=True)
disk = out / ('guest-' + secrets.token_hex(4) + '.raw')
mount = out / ('mount-' + secrets.token_hex(4))
mount.mkdir()
password = secrets.token_urlsafe(24)
checks = {}
process = None


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition:
        raise AssertionError(name)


url = 'http://' + args.bind + ':' + str(args.port)


def rpc(sid, obj, method, params=None, required=True):
    request = urllib.request.Request(url + '/ubus', data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'call',
        'params': [sid, obj, method, params or {}]}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.load(response)
    result = payload.get('result', [payload.get('error', {}).get('code', -1)])
    if required and result[0] != 0:
        raise RuntimeError(obj + '.' + method + ' failed: ' + str(result[0]))
    return result[1] if len(result) > 1 else result[0]


try:
    with gzip.open(args.image, 'rb') as source, disk.open('wb') as dest:
        shutil.copyfileobj(source, dest)
    disk.chmod(0o600)
    with disk.open('rb') as stream:
        mbr = stream.read(512)
    assert mbr[510:512] == b'\x55\xaa' and mbr[466] == 0x83
    offset = struct.unpack_from('<I', mbr, 470)[0] * 512
    assert 0 < offset < disk.stat().st_size
    subprocess.run(['mount', '-o', 'loop,offset=' + str(offset), str(disk), str(mount)], check=True)
    try:
        hashed = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=password + '\n', text=True, capture_output=True, check=True).stdout.strip()
        seed = mount / 'etc/freeisp/root.hash'
        seed.parent.mkdir(exist_ok=True)
        seed.write_text(hashed + '\n')
        seed.chmod(0o600)
        # Install this checkout's coherent UI/menu/ACL overlay: the cached image
        # may predate its navigation, theme and Quick Set. Keep guest config intact.
        for name in ['www', 'usr/share/luci/menu.d', 'usr/share/rpcd/acl.d']:
            shutil.copytree(project / 'openwrt/files' / name, mount / name, dirs_exist_ok=True)
        with (mount / 'etc/config/rpcd').open('a') as config:
            config.write("\nconfig login\n option username 'logreader'\n option password '" + hashed + "'\n list read 'luci-app-freeisp-log'\n")
    finally:
        subprocess.run(['umount', str(mount)], check=True)
    with (out / 'console.log').open('w') as console:
        kvm = os.access('/dev/kvm', os.R_OK | os.W_OK)
        process = subprocess.Popen([
            'qemu-system-x86_64', '-machine', 'q35', '-accel', 'kvm' if kvm else 'tcg', '-cpu', 'host' if kvm else 'max', '-m', '512', '-smp', '2',
            '-drive', 'file=' + str(disk) + ',format=raw,if=virtio',
            '-netdev', 'user,id=wan,restrict=on', '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
            '-netdev', 'user,id=lan,restrict=on', '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
            '-netdev', 'user,id=management,net=10.78.0.0/24,restrict=on,hostfwd=tcp:' + args.bind + ':' + str(args.port) + '-10.78.0.15:80',
            '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
            '-display', 'none', '-monitor', 'none', '-serial', 'stdio'], stdin=subprocess.PIPE, stdout=console, stderr=subprocess.STDOUT)
        zero = '0' * 32
        for attempt in range(120):
            try:
                sid = rpc(zero, 'session', 'login', {'username': 'root', 'password': password})['ubus_rpc_session']
                break
            except Exception:
                if process.poll() is not None:
                    raise RuntimeError('Test VM exited; see console.log')
                time.sleep(1)
        else:
            raise RuntimeError('Test VM did not become ready')
        check('actual_openwrt_25_12_5', rpc(sid, 'system', 'board')['release']['version'] == '25.12.5')
        read = {'lines': 1000, 'stream': False, 'oneshot': True}
        log = rpc(sid, 'log', 'read', read)
        check('real_buffer_read', isinstance(log.get('log'), list) and len(log['log']) > 0)
        marker = 'freeisp-log-test-' + secrets.token_hex(8)
        # Command execution over RPC is unavailable in this image.
        # Use the disposable guest's local serial console to generate a real event.
        process.stdin.write(b'\n'); process.stdin.flush(); time.sleep(1)
        process.stdin.write(('/usr/bin/logger -p daemon.info -t freeisp-log-test ' + marker + '\n').encode())
        process.stdin.flush(); time.sleep(2)
        entries = rpc(sid, 'log', 'read', read)['log']
        check('new_backend_event_visible', any(marker in entry['msg'] and entry['priority'] == 30 for entry in entries))
        denied = rpc(zero, 'log', 'read', read, required=False)
        check('anonymous_read_denied', isinstance(denied, int) and denied != 0)
        denied = rpc(zero, 'session', 'login', {'username': 'root', 'password': 'invalid-test-password'}, required=False)
        check('invalid_password_denied', isinstance(denied, int) and denied != 0)
        reader = rpc(zero, 'session', 'login', {'username': 'logreader', 'password': password})['ubus_rpc_session']
        check('read_only_account_reads_logs', marker in json.dumps(rpc(reader, 'log', 'read', read)))
        check('root_can_set_config', rpc(sid, 'session', 'access', {'scope': 'ubus', 'object': 'uci', 'function': 'set'})['access'])
        denied = rpc(reader, 'uci', 'set', {'config': 'system', 'section': '@system[0]', 'values': {'hostname': 'must-not-change'}}, required=False)
        check('read_only_account_cannot_change_settings', isinstance(denied, int) and denied != 0)
        (out / 'real-log.json').write_text(json.dumps({'log': entries}))
        (out / 'result.json').write_text(json.dumps({'passed': True, 'checks': checks, 'router': 'isolated OpenWrt 25.12.5 VM'}, indent=2))
        runtime = out / 'runtime.json'
        runtime.write_text(json.dumps({'url': url, 'username': 'root', 'password': password, 'marker': marker}))
        runtime.chmod(0o600)
        print('Real backend checks passed. Browser target: ' + url, flush=True)
        if args.hold:
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline and not (out / 'STOP').exists() and process.poll() is None:
                time.sleep(1)
finally:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    # These paths were created above inside this test's output directory.
    if disk.exists():
        disk.unlink()
    mount.rmdir()
    (out / 'runtime.json').unlink(missing_ok=True)
