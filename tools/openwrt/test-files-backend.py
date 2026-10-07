"""Exercise real rpcd and CGI file actions in a disposable local OpenWrt VM.

Run as root on a Linux test host with qemu, mount, openssl and Python installed.
Pass an existing FreeISP ext4 combined image as FREEISP_TEST_IMAGE. It is copied,
never modified. Only loopback ports are forwarded; no host networking is changed.
The temporary router credentials and VM disk are removed at the end.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECT = Path(__file__).resolve().parents[2]
OUT = PROJECT / 'artifacts/tests/files'
OUT.mkdir(parents=True, exist_ok=True)
checks = {}


def check(name, passed):
    checks[name] = bool(passed)
    print(name + ': ' + ('PASS' if passed else 'FAIL'), flush=True)
    if not passed:
        raise AssertionError(name)


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Router:
    def __init__(self, http_port):
        self.url = 'http://127.0.0.1:' + str(http_port)
        self.sid = '0' * 32
        self.timeout = 15

    def rpc(self, obj, method, args=None, required=True):
        payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'call', 'params': [self.sid, obj, method, args or {}]}
        req = urllib.request.Request(self.url + '/ubus', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            value = json.load(response)
        result = value.get('result', [value.get('error', {}).get('code', -1)])
        if not required:
            return result
        if result[0] != 0:
            raise RuntimeError(obj + '.' + method + ' returned code ' + str(result[0]))
        return result[1] if len(result) > 1 else result[0]

    def login(self, username, password):
        self.sid = '0' * 32
        self.sid = self.rpc('session', 'login', {'username': username, 'password': password})['ubus_rpc_session']

    def ready(self, password):
        self.sid = '0' * 32
        self.timeout = 3
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                self.login('root', password)
                self.timeout = 15
                return
            except (OSError, ValueError, RuntimeError):
                time.sleep(1)
        raise RuntimeError('Test router did not become ready')

    def restart(self, password):
        self.rpc('system', 'reboot')
        deadline = time.monotonic() + 30
        self.timeout = 2
        while time.monotonic() < deadline:
            try:
                self.rpc('system', 'board')
            except (OSError, ValueError, RuntimeError):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError('Router did not disconnect for reboot')
        self.ready(password)

    def download(self, path):
        data = urllib.parse.urlencode({'sessionid': self.sid, 'path': path}).encode()
        with urllib.request.urlopen(self.url + '/cgi-bin/cgi-download', data, timeout=15) as response:
            return response.read()

    def upload(self, path, contents):
        boundary = 'FreeISPTest' + secrets.token_hex(12)
        data = b''
        for name, value in [('sessionid', self.sid), ('filename', path)]:
            data += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode()
        data += (f'--{boundary}\r\nContent-Disposition: form-data; name="filedata"; filename="test.bin"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + contents + (f'\r\n--{boundary}--\r\n').encode()
        req = urllib.request.Request(self.url + '/cgi-bin/cgi-upload', data, {'Content-Type': 'multipart/form-data; boundary=' + boundary})
        with urllib.request.urlopen(req, timeout=15) as response:
            result = json.load(response)
        if result.get('failure'):
            raise RuntimeError('CGI upload failed: ' + str(result.get('message', result['failure'])))
        return result


def main():
    image = Path(os.environ['FREEISP_TEST_IMAGE']).resolve(strict=True)
    password = secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory(prefix='freeisp-files-test-') as temporary:
        temp = Path(temporary)
        disk = temp / 'router.raw'
        with gzip.open(image, 'rb') as source, disk.open('wb') as target:
            shutil.copyfileobj(source, target)
        with disk.open('rb') as source:
            mbr = source.read(512)
        offset = struct.unpack_from('<I', mbr, 446 + 16 + 8)[0] * 512
        if offset <= 0:
            raise RuntimeError('Expected ext4 combined image with second root partition')
        mount = temp / 'root'
        mount.mkdir()
        command('mount', '-o', 'loop,offset=' + str(offset), str(disk), str(mount))
        try:
            shutil.copytree(PROJECT / 'openwrt/files', mount, dirs_exist_ok=True)
            # Also support older Windows checkouts created before the LF attributes.
            for folder in ['etc/uci-defaults', 'etc/config', 'usr/bin', 'usr/libexec']:
                overlay_folder = PROJECT / 'openwrt/files' / folder
                if overlay_folder.exists():
                    for source in overlay_folder.iterdir():
                        if source.is_file() and not source.is_symlink():
                            (mount / folder / source.name).write_bytes(source.read_bytes().replace(b'\r\n', b'\n'))
            hashed = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=password + '\n', capture_output=True, text=True, check=True).stdout.strip()
            (mount / 'etc/freeisp').mkdir(exist_ok=True)
            (mount / 'etc/freeisp/root.hash').write_text(hashed + '\n')
            (mount / 'etc/freeisp/root.hash').chmod(0o600)
            # Test accounts exercise the feature-specific ACL, without root wildcard access.
            with (mount / 'etc/config/rpcd').open('a') as config:
                for username, writable in [('files-test', True), ('files-reader', False)]:
                    config.write("\nconfig login\n option username '" + username + "'\n option password '" + hashed + "'\n list read 'luci-app-freeisp-files'\n")
                    if writable:
                        config.write(" list write 'luci-app-freeisp-files'\n")
            for script in (mount / 'etc/uci-defaults').iterdir():
                script.chmod(0o755)
            # Seed only a sample subfolder; the defaults script must secure its parent.
            (mount / 'srv/freeisp-files/hotspot').mkdir(parents=True)
        finally:
            command('umount', str(mount))
        http_port = port()
        kvm = os.access('/dev/kvm', os.R_OK | os.W_OK)
        args = ['qemu-system-x86_64', '-machine', 'q35', '-accel', 'kvm' if kvm else 'tcg', '-cpu', 'host' if kvm else 'max', '-m', '384', '-smp', '2', '-drive', 'file=' + str(disk) + ',format=raw,if=virtio',
                '-netdev', 'user,id=wan,restrict=on', '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
                '-netdev', 'user,id=lan,restrict=on,net=10.77.0.0/24', '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
                '-netdev', 'user,id=maintenance,restrict=on,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:' + str(http_port) + '-10.78.0.15:80',
                '-device', 'virtio-net-pci,netdev=maintenance,mac=52:54:00:f1:00:03', '-display', 'none', '-monitor', 'none', '-serial', 'stdio']
        router = Router(http_port)
        process = None
        completed = False
        with (OUT / 'backend-boot.log').open('w') as log:
            try:
                process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
                router.ready(password)
                storage = router.rpc('file', 'lstat', {'path': '/srv/freeisp-files'})
                check('storage-initialized-mode-0700', storage['type'] == 'directory' and storage['mode'] & 0o777 == 0o700)
                check('network-regression-interface-dump', len(router.rpc('network.interface', 'dump')['interface']) >= 4)
                check('system-regression-board', router.rpc('system', 'board')['release']['distribution'] == 'OpenWrt')
                files = Router(http_port)
                files.login('files-test', password)
                payload = bytes(range(256)) * 32
                destination = '/srv/freeisp-files/hotspot/upload test.bin'
                check('cgi-binary-upload', files.upload(destination, payload)['size'] == len(payload))
                check('nested-list', any(e['name'] == 'upload test.bin' for e in files.rpc('file', 'list', {'path': '/srv/freeisp-files/hotspot'})['entries']))
                check('binary-download-exact', files.download(destination) == payload)
                check('lstat-metadata', files.rpc('file', 'lstat', {'path': destination})['size'] == len(payload))
                check('outside-read-denied', files.rpc('file', 'read', {'path': '/etc/shadow'}, False)[0] != 0)
                check('path-traversal-denied', files.rpc('file', 'read', {'path': '/srv/freeisp-files/../../etc/shadow'}, False)[0] != 0)
                check('invalid-path-denied', files.rpc('file', 'list', {'path': ''}, False)[0] != 0)
                check('missing-file-fails', files.rpc('file', 'lstat', {'path': '/srv/freeisp-files/missing'}, False)[0] != 0)
                readonly = Router(http_port)
                readonly.login('files-reader', password)
                check('readonly-download', readonly.download(destination) == payload)
                check('readonly-delete-denied', readonly.rpc('file', 'remove', {'path': destination}, False)[0] != 0)
                try:
                    readonly.upload('/srv/freeisp-files/denied.bin', b'forbidden')
                    denied = False
                except (urllib.error.HTTPError, RuntimeError):
                    denied = True
                check('readonly-upload-denied', denied)
                router.restart(password)
                check('connection-loss-observed-during-reboot', True)
                files.login('files-test', password)
                check('uploaded-file-survives-restart', files.download(destination) == payload)
                check('file-delete', files.rpc('file', 'remove', {'path': destination}) == 0)
                check('delete-list-refreshed', not files.rpc('file', 'list', {'path': '/srv/freeisp-files/hotspot'})['entries'])
                router.restart(password)
                files.login('files-test', password)
                check('deletion-survives-restart', files.rpc('file', 'lstat', {'path': destination}, False)[0] != 0)
                check('network-survives-restart', len(router.rpc('network.interface', 'dump')['interface']) >= 4)
                completed = True
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
                (OUT / 'backend-result.json').write_text(json.dumps({'checks': checks, 'passed': completed and all(checks.values()), 'image_sha256': hashlib.sha256(image.read_bytes()).hexdigest(), 'scope': 'Disposable local VM; no deployed router modified'}, indent=2) + '\n')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()
