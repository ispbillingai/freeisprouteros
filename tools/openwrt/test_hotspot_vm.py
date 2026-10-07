"""Boot a disposable copy of an OpenWrt image and test the installed Hotspot RPC.

Linux root only. Never operates on the original disk, host routes, or a live router.
Usage: python3 tools/openwrt/test_hotspot_vm.py --image /private/router.img.gz
Package installation uses the guest's signed OpenWrt feeds. The generated test
password and private disk stay in an ignored directory and are never reported.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import struct
import subprocess
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[2]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def rpc(port, sid, obj, method, args=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}/ubus', data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'call',
        'params': [sid, obj, method, args or {}]}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    return result.get('result', [result.get('error', {}).get('code', -1)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--run-name', default='', help='Optional separate artifact directory suffix for another isolated run')
    parser.add_argument('--reuse', action='store_true', help='Reuse this runner\'s stopped disposable disk after a failed run')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run as root in an isolated Linux builder.')
    if args.run_name and not all(c.isalnum() or c == '-' for c in args.run_name):
        raise SystemExit('Run name may contain only letters, numbers and hyphens.')
    out = PROJECT / 'artifacts/tests' / ('hotspot-vm' + ('-' + args.run_name if args.run_name else ''))
    out.mkdir(parents=True, exist_ok=True)
    out.chmod(0o700)
    disk = out / 'test-router.raw'
    report = {'checks': {}, 'image_sha256': hashlib.sha256(args.image.read_bytes()).hexdigest()}
    def check(name, condition):
        report['checks'][name] = bool(condition)
        print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
        if not condition:
            raise AssertionError(name)
    if disk.exists():
        previous = json.loads((out / 'validation.json').read_text()) if (out / 'validation.json').exists() else {}
        if not args.reuse or previous.get('image_sha256') != report['image_sha256']:
            raise SystemExit('Test disk already exists; choose a fresh run name, or explicitly reuse a stopped test disk with matching provenance.')
    password = secrets.token_urlsafe(24)
    hashed = run('openssl', 'passwd', '-6', '-stdin', input=password + '\n').stdout.strip()
    if not disk.exists():
        with gzip.open(args.image, 'rb') as source, disk.open('xb') as target:
            shutil.copyfileobj(source, target)
    disk.chmod(0o600)
    with disk.open('rb') as stream:
        mbr = stream.read(512)
    if mbr[510:512] != b'\x55\xaa' or mbr[466] != 0x83:
        raise SystemExit('Expected the OpenWrt x86 ext4 disk layout.')
    offset = struct.unpack_from('<I', mbr, 470)[0] * 512
    mount = out / 'root'
    mount.mkdir(exist_ok=True)
    run('mount', '-o', f'loop,offset={offset}', str(disk), str(mount))
    try:
        shutil.copytree(PROJECT / 'openwrt/files', mount, dirs_exist_ok=True)
        # Reset only state created by this runner in its private test disk.
        for relative in ('etc/freeisp/hotspot.json', 'etc/freeisp/hotspot-state.json',
                         'etc/nftables.d/70-freeisp-hotspot-guard.nft'):
            (mount / relative).unlink(missing_ok=True)
        secret = mount / 'etc/freeisp/root.hash'
        secret.parent.mkdir(parents=True, exist_ok=True)
        secret.write_text(hashed + '\n')
        secret.chmod(0o600)
        for directory in ('etc/uci-defaults', 'usr/libexec/rpcd', 'etc/init.d'):
            for file in (mount / directory).iterdir():
                if file.is_file() and ('freeisp' in file.name):
                    file.chmod(0o755)
        # A fixed check endpoint exists only in this private test image. The
        # production RPC deliberately has no arbitrary command-execution method.
        checker = mount / 'usr/libexec/rpcd/freeisp.hotspot-test'
        checker.write_text('''#!/usr/bin/python3
import json, shutil, subprocess, sys
if sys.argv[1:] == ['list']:
    print(json.dumps({'check': {}}))
elif sys.argv[1:] == ['call', 'check']:
    result = subprocess.run([shutil.which('fw4'), 'check'], text=True, capture_output=True, timeout=20)
    print(json.dumps({'code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
else:
    print(json.dumps({'code': 2}))
''')
        checker.chmod(0o755)
        (mount / 'usr/share/rpcd/acl.d/freeisp-hotspot-test.json').write_text(json.dumps({
            'freeisp-hotspot-test': {'description': 'Disposable VM test only',
                                   'read': {'ubus': {'freeisp.hotspot-test': ['check']}}}}))
        # Startup performs package installation inside this disposable guest.
        (mount / 'etc/rc.local').write_text('''#!/bin/sh
(
    for n in 1 2 3 4 5; do
        command -v python3 && break
        apk update && apk add python3 && break
        sleep 3
    done
    /etc/init.d/freeisp-hotspot restart
    /etc/init.d/rpcd restart
    sleep 5
    timeout 25 ubus call freeisp.hotspot snapshot
    logread -e freeisp
) >/etc/freeisp/hotspot-test-install.log 2>&1 &
exit 0
''')
    finally:
        run('umount', str(mount))
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    accel = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
    command = ['qemu-system-x86_64', '-machine', 'q35', '-accel', accel,
        '-cpu', 'host' if accel == 'kvm' else 'max', '-m', '768', '-smp', '2',
        '-drive', f'file={disk},format=raw,if=virtio',
        '-netdev', 'user,id=wan', '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
        '-netdev', 'user,id=lan,net=10.77.0.0/24,restrict=on',
        '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
        '-netdev', f'user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:{port}-10.78.0.15:80,restrict=on',
        '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
        '-display', 'none', '-monitor', 'none', '-serial', 'stdio']
    log = (out / 'boot.log').open('w')
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    zero = '0' * 32
    sid = None
    try:
        for _ in range(120):
            try:
                result = rpc(port, zero, 'session', 'login', {'username': 'root', 'password': password})
                if result[0] == 0:
                    sid = result[1]['ubus_rpc_session']
                    break
            except (OSError, ValueError):
                pass
            if process.poll() is not None:
                raise RuntimeError('Disposable VM stopped during boot.')
            time.sleep(2)
        check('openwrt_authenticated_boot', sid is not None)
        snapshot = None
        for attempt in range(90):
            if attempt and attempt % 20 == 0:
                renewed = rpc(port, zero, 'session', 'login', {'username': 'root', 'password': password})
                sid = renewed[1]['ubus_rpc_session']
            result = rpc(port, sid, 'freeisp.hotspot', 'snapshot')
            if result[0] == 0 and len(result) > 1 and 'collections' in result[1]:
                snapshot = result[1]
                break
            if attempt % 20 == 0:
                print('Waiting for Hotspot RPC: ' + json.dumps(result), flush=True)
            time.sleep(2)
        if snapshot is None:
            install = rpc(port, sid, 'file', 'read', {'path': '/etc/freeisp/hotspot-test-install.log'})
            (out / 'install-result.json').write_text(json.dumps(install, indent=2))
        check('installed_hotspot_rpc_responds', snapshot is not None)
        check('all_eleven_collections_available', set(snapshot['collections']) == {
            'servers', 'server_profiles', 'users', 'user_profiles', 'active', 'hosts',
            'ip_bindings', 'service_ports', 'walled_garden', 'walled_garden_ip', 'cookies'})
        check('anonymous_snapshot_denied', rpc(port, zero, 'freeisp.hotspot', 'snapshot')[0] != 0)
        check('anonymous_mutation_denied', rpc(port, zero, 'freeisp.hotspot', 'mutate',
            {'action': 'save', 'payload': '{}'})[0] != 0)
        interfaces = snapshot.get('interfaces', [])
        check('customer_interface_discovered', any(i.get('name') == 'br-lan' or i.get('device') == 'br-lan' for i in interfaces))
        # A real persistence round trip through LuCI's exact RPC transport.
        result = rpc(port, sid, 'freeisp.hotspot', 'mutate', {'action': 'save', 'payload': json.dumps({
            'revision': snapshot['revision'], 'collection': 'user_profiles',
            'record': {'name': 'vm-smoke', 'session_timeout': 120, 'idle_timeout': 60,
                       'shared_users': 1, 'disabled': False}})})
        check('profile_save_via_rpc', result[0] == 0 and result[1].get('ok') is True)
        snapshot = rpc(port, sid, 'freeisp.hotspot', 'snapshot')[1]
        profile = next((p for p in snapshot['collections']['user_profiles'] if p['name'] == 'vm-smoke'), None)
        check('profile_visible_after_save', profile is not None)
        result = rpc(port, sid, 'freeisp.hotspot', 'mutate', {'action': 'remove', 'payload': json.dumps({
            'revision': snapshot['revision'], 'collection': 'user_profiles', 'ids': [profile['id']]})})
        check('profile_remove_via_rpc', result[0] == 0 and result[1].get('ok') is True)
        def mutate(action, **payload):
            current = rpc(port, sid, 'freeisp.hotspot', 'snapshot')[1]
            payload['revision'] = current['revision']
            response = rpc(port, sid, 'freeisp.hotspot', 'mutate',
                           {'action': action, 'payload': json.dumps(payload)})
            if response[0] != 0 or not response[1].get('ok'):
                raise AssertionError('Real Hotspot mutation failed: ' + json.dumps(response))
            return response[1]
        server = mutate('setup', name='vm-hotspot', interface='br-lan',
                        local_address='10.77.0.1', address_pool='10.77.0.0/24')['id']
        snapshot = rpc(port, sid, 'freeisp.hotspot', 'snapshot')[1]
        check('real_server_setup_and_enforcement', snapshot['runtime']['available'] and len(snapshot['collections']['servers']) == 1)
        user_profile = snapshot['collections']['user_profiles'][0]['id']
        records = {
            'users': {'name': 'vm-customer', 'password': secrets.token_urlsafe(20), 'profile': user_profile},
            'ip_bindings': {'address': '10.77.0.101', 'type': 'blocked'},
            'service_ports': {'name': 'customer-test-service', 'protocol': 'tcp', 'ports': '8080'},
            'walled_garden': {'host': 'downloads.openwrt.org', 'port': 443, 'action': 'allow'},
            'walled_garden_ip': {'dst_address': '198.18.0.1', 'protocol': 'tcp', 'dst_port': '443', 'action': 'allow'},
        }
        for collection, record in records.items():
            identity = mutate('save', collection=collection, record=record)['id']
            mutate('set_enabled', collection=collection, ids=[identity], enabled=False)
            mutate('set_enabled', collection=collection, ids=[identity], enabled=True)
            mutate('remove', collection=collection, ids=[identity])
            check('real_' + collection + '_save_toggle_remove', True)
        mutate('reset_html', server_id=server)
        check('real_portal_reset', True)
        current = rpc(port, sid, 'freeisp.hotspot', 'snapshot')[1]
        server_profile = current['collections']['servers'][0]['profile']
        mutate('set_enabled', collection='server_profiles', ids=[server_profile], enabled=False)
        mutate('set_enabled', collection='server_profiles', ids=[server_profile], enabled=True)
        check('real_server_profile_disable_reenable', True)
        guard = rpc(port, sid, 'freeisp.hotspot-test', 'check')
        (out / 'firewall-check.json').write_text(json.dumps(guard, indent=2) + '\n')
        if guard[0] != 0 or guard[1].get('code') != 0:
            print('Firewall check response: ' + json.dumps(guard), flush=True)
        check('openwrt_firewall_accepts_persistent_guard', guard[0] == 0 and guard[1].get('code') == 0)
        mutate('set_enabled', collection='servers', ids=[server], enabled=False)
        mutate('set_enabled', collection='servers', ids=[server], enabled=True)
        mutate('remove', collection='servers', ids=[server])
        check('real_server_disable_reenable_remove', True)
        for url in ('/luci-static/resources/view/freeisp/hotspot.js', '/luci-static/resources/freeisp/hotspot.css'):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}' + url) as response:
                check('asset_served_' + url.rsplit('/', 1)[1], response.status == 200 and len(response.read()) > 100)
        report['complete'] = True
    finally:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
        (out / 'validation.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
