"""Firewall integration test in a disposable, loopback-only OpenWrt VM.

Run on a Linux host with root, QEMU, ssh, and an existing OpenWrt image:
  FREEISP_TEST_IMAGE=/path/to/image.img.gz python3 tools/openwrt/test-firewall-vm.py
No running router or host network configuration is modified.
"""
import gzip
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

PROJECT = Path(__file__).resolve().parents[2]
OUT = PROJECT / 'artifacts/tests/firewall/vm'
OUT.mkdir(parents=True, exist_ok=True)
IMAGE = Path(os.environ['FREEISP_TEST_IMAGE']).resolve(strict=True)
checks = {}


def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition:
        raise AssertionError(name)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='freeisp-firewall-vm-') as directory:
    work = Path(directory)
    disk, mount, key = work / 'router.raw', work / 'root', work / 'test-key'
    process = None
    mounted = False
    log = open(OUT / 'boot.log', 'w')
    ssh_port, web_port = free_port(), free_port()
    try:
        with gzip.open(IMAGE, 'rb') as source, disk.open('wb') as dest:
            shutil.copyfileobj(source, dest)
        with disk.open('rb') as stream:
            mbr = stream.read(512)
        assert mbr[510:512] == b'\x55\xaa' and mbr[466] == 0x83
        offset = struct.unpack_from('<I', mbr, 470)[0] * 512
        assert 0 < offset < disk.stat().st_size
        mount.mkdir()
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        subprocess.run(['mount', '-o', f'loop,offset={offset}', str(disk), str(mount)], check=True)
        mounted = True
        try:
            overlay = PROJECT / 'openwrt/files'
            for relative in ['usr/bin/freeisp-firewall-status',
                             'usr/share/luci/menu.d/luci-app-freeisp.json',
                             'usr/share/rpcd/acl.d/luci-app-freeisp.json']:
                target = mount / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(overlay / relative, target)
            shutil.copytree(overlay / 'www', mount / 'www', dirs_exist_ok=True)
            (mount / 'usr/bin/freeisp-firewall-status').chmod(0o755)
            (mount / 'etc/dropbear').mkdir(exist_ok=True)
            (mount / 'etc/dropbear/authorized_keys').write_text(key.with_suffix('.pub').read_text())
            (mount / 'etc/dropbear/authorized_keys').chmod(0o600)
        finally:
            subprocess.run(['umount', str(mount)], check=True)
            mounted = False
        accel = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
        command = ['qemu-system-x86_64', '-machine', 'q35', '-accel', accel,
                   '-cpu', 'host' if accel == 'kvm' else 'max', '-m', '512', '-smp', '2',
                   '-drive', f'file={disk},format=raw,if=virtio',
                   '-netdev', 'user,id=wan,restrict=on',
                   '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
                   '-netdev', f'user,id=lan,net=10.77.0.0/24,hostfwd=tcp:127.0.0.1:{web_port}-10.77.0.1:443,restrict=on',
                   '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
                   '-netdev', f'user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:{ssh_port}-10.78.0.15:22,restrict=on',
                   '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
                   '-display', 'none', '-monitor', 'none', '-serial', 'stdio']
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        ssh_command = ['ssh', '-i', str(key), '-p', str(ssh_port), '-o', 'BatchMode=yes',
                       '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new',
                       '-o', f'UserKnownHostsFile={work / "known_hosts"}', 'root@127.0.0.1']

        def ssh(args, required=True, input=None):
            result = subprocess.run(ssh_command + [shlex.join(args)], input=input, text=True,
                                    capture_output=True, timeout=40)
            if required and result.returncode:
                raise RuntimeError(result.stderr[-2000:])
            return result

        for attempt in range(100):
            if ssh(['/bin/true'], required=False).returncode == 0:
                break
            if process.poll() is not None:
                raise RuntimeError('Disposable guest exited: ' + (OUT / 'boot.log').read_text()[-2000:])
            time.sleep(1)
        else:
            raise RuntimeError('Disposable guest boot timed out')
        check('isolated_guest_boot', True)
        check('openwrt_25_12_5', '25.12.5' in ssh(['/bin/cat', '/etc/openwrt_release']).stdout)
        check('baseline_fw4_check', ssh(['/sbin/fw4', 'check'], required=False).returncode == 0)
        status = ssh(['/usr/bin/freeisp-firewall-status'])
        json.loads(status.stdout)
        (OUT / 'runtime-before.json').write_text(status.stdout)
        check('runtime_helper_returns_json', True)
        check('runtime_helper_rejects_arguments', ssh(['/usr/bin/freeisp-firewall-status', 'restart'], required=False).returncode != 0)
        # Generated by the model unit test, so the actual form's validation and
        # normalization are covered by the same compiler checks.
        fixture = json.loads((PROJECT / 'tools/openwrt/firewall-test-cases.json').read_text())
        cases = [{'id': section['.name'], 'section': section}
                 for section in fixture['ipsets'] + fixture['cases']]
        for case in cases:
            section = dict(case['section'])
            section.pop('.name', None)
            section_type = section.pop('.type')
            section = {key: value for key, value in section.items() if value not in ('', [])}
            # ubus local uci accepts lists and strings without shell interpolation.
            arguments = {'config': 'firewall', 'type': section_type,
                         'name': 'freeisp_test_' + case['id'], 'values': section}
            result = ssh(['/bin/ubus', 'call', 'uci', 'add', json.dumps(arguments)])
            check('uci_' + case['id'], 'section' in json.loads(result.stdout))
        ssh(['/sbin/uci', 'commit', 'firewall'])
        compile_result = ssh(['/sbin/fw4', 'check'], required=False)
        (OUT / 'fw4-check.txt').write_text(compile_result.stdout + compile_result.stderr)
        check('all_supported_actions_compile', compile_result.returncode == 0)
        ruleset = ssh(['/sbin/fw4', 'print']).stdout
        (OUT / 'compiled.nft').write_text(ruleset)
        for case in cases:
            if case['section']['.type'] != 'ipset':
                check('compiled_' + case['id'], case['section']['name'] in ruleset)
        ssh(['/sbin/fw4', 'reload'])
        check('applied_ruleset_has_counters', 'counter packets' in ssh(['/usr/sbin/nft', 'list', 'table', 'inet', 'fw4']).stdout)

        def https_available():
            try:
                with urllib.request.urlopen(f'https://127.0.0.1:{web_port}/', timeout=4,
                                            context=ssl._create_unverified_context()) as response:
                    return response.status == 200
            except (OSError, urllib.error.URLError):
                return False

        check('lan_https_before_block', https_available())
        blocker = {'config': 'firewall', 'type': 'rule', 'name': 'freeisp_packet_test',
                   'values': {'name': 'FreeISP-packet-test', 'src': 'lan', 'proto': 'tcp',
                              'dest_port': '443', 'target': 'REJECT', 'family': 'ipv4'}}
        ssh(['/bin/ubus', 'call', 'uci', 'add', json.dumps(blocker)])
        ssh(['/sbin/uci', 'commit', 'firewall'])
        ssh(['/sbin/fw4', 'reload'])
        check('filter_reject_blocks_new_lan_https', not https_available())
        check('maintenance_still_reachable', ssh(['/bin/true']).returncode == 0)
        kernel = json.loads(ssh(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'fw4']).stdout)
        rules = [item['rule'] for item in kernel['nftables'] if 'rule' in item]
        matching = [r for r in rules if r.get('comment') == '!fw4: FreeISP-packet-test']
        check('blocked_packets_increment_real_counter', any(
            expr.get('counter', {}).get('packets', 0) > 0 for rule in matching for expr in rule['expr']))
        ssh(['/sbin/uci', 'delete', 'firewall.freeisp_packet_test'])
        ssh(['/sbin/uci', 'commit', 'firewall'])
        ssh(['/sbin/fw4', 'reload'])
        check('filter_removal_restores_lan_https', https_available())
        (OUT / 'runtime-after.json').write_text(ssh(['/usr/bin/freeisp-firewall-status']).stdout)
        check('verification_complete', True)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        log.close()
        if mounted:
            subprocess.run(['umount', str(mount)], check=False)
        (OUT / 'validation.json').write_text(json.dumps({
            'status': 'passed' if checks.get('verification_complete') else 'failed_or_incomplete',
            'checks': checks,
            'scope': 'Disposable OpenWrt VM; host networking and deployed router untouched',
            'not_tested': ['production router deployment', 'production traffic load',
                           'NAT through a separate customer VM', 'physical hardware']
        }, indent=2) + '\n')
