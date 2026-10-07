#!/usr/bin/env python3
"""Stage a reviewed OpenWrt overlay; activate only after separate browser review.

Run on the Ubuntu QEMU host as root. The first invocation snapshots the stopped
live guest, restarts it, and leaves a separate staged guest running. Run again
with --activate-only after checking port 8892. No passwords enter argv or logs.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request


PACKAGES = ['ip-bridge', 'tc-full', 'rp-pppoe-server', 'python3',
            'kmod-sched-core', 'kmod-sched-act-police']
DEFAULTS = ['98-freeisp-wifi', '99-freeisp-files', '98-freeisp-pppoe']


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + ' failed: ' +
                           result.stderr.decode(errors='replace')[-500:])
    return result.stdout


def save(path, data):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ssh(args, password, port, command, data=None, timeout=90):
    read, write = os.pipe()
    try:
        os.write(write, (password + '\n').encode())
    finally:
        os.close(write)
    try:
        return run(['sshpass', '-d', str(read), 'ssh', '-T', '-p', str(port),
                    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
                    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
                    '-o', 'HostKeyAlias=[127.0.0.1]:2224',
                    '-o', 'UserKnownHostsFile=' + str(args.guest_known_hosts),
                    'root@127.0.0.1', command], input=data, pass_fds=(read,), timeout=timeout)
    finally:
        os.close(read)


def ready(args, password, port):
    for _ in range(90):
        try:
            ssh(args, password, port, 'true', timeout=8)
            return
        except (RuntimeError, subprocess.TimeoutExpired):
            time.sleep(2)
    raise RuntimeError('Guest SSH did not become ready on port ' + str(port))


def configuration_hash(args, password, port):
    # Return only a digest, never network settings or subscriber credentials.
    command = "{ find /etc/config -type f -exec sha256sum '{}' ';'; " \
              "[ ! -f /etc/freeisp/pppoe.json ] || sha256sum /etc/freeisp/pppoe.json; " \
              "} | LC_ALL=C sort | sha256sum"
    value = ssh(args, password, port, command).decode().split()[0]
    if not re.fullmatch('[a-f0-9]{64}', value):
        raise RuntimeError('Could not fingerprint live configuration.')
    return value


def overlay(args):
    base = args.source / 'openwrt/files'
    manifest_path = base / 'www/luci-static/freeisp/release.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('schema') != 1 or not re.fullmatch('[a-f0-9]{64}', manifest.get('revision', '')):
        raise RuntimeError('Expected schema 1 release manifest with SHA256 revision.')
    selected = []
    for path in sorted(base.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(base).as_posix()
        allowed = (relative.startswith(('www/luci-static/freeisp/', 'www/luci-static/freeisp-night/',
                    'www/luci-static/resources/freeisp/', 'www/luci-static/resources/view/freeisp/',
                    'usr/share/luci/menu.d/luci-app-freeisp', 'usr/share/rpcd/acl.d/luci-app-freeisp',
                    'usr/lib/freeisp/', 'usr/libexec/freeisp-', 'usr/libexec/rpcd/freeisp.'))
                   or relative in ['usr/bin/freeisp-command-line', 'usr/bin/freeisp-resources',
                                   'etc/init.d/freeisp-pppoe']
                   or relative in ['etc/uci-defaults/' + name for name in DEFAULTS])
        if allowed:
            if path.is_symlink():
                raise RuntimeError('Overlay must not contain symbolic links: ' + relative)
            selected.append((path, relative))
    if not selected:
        raise RuntimeError('Empty feature overlay.')
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for path, relative in selected:
            content = path.read_bytes().replace(b'\r\n', b'\n')
            info = tarfile.TarInfo(relative)
            info.size = len(content)
            info.mode = 0o755 if relative.startswith(('usr/bin/', 'usr/libexec/', 'etc/init.d/', 'etc/uci-defaults/')) else 0o644
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue(), manifest, len(selected)


def stage_alive(state):
    try:
        command = Path('/proc/' + str(state['stage_pid']) + '/cmdline').read_bytes()
        return b'qemu-system-x86_64' in command and str(state['stage_disk']).encode() in command
    except FileNotFoundError:
        return False


def stop_stage(args, password, state):
    if not stage_alive(state):
        return
    try:
        ssh(args, password, 2225, 'sync; poweroff', timeout=15)
    except (RuntimeError, subprocess.TimeoutExpired):
        pass  # Guest SSH is expected to disconnect while powering off.
    for _ in range(60):
        if not stage_alive(state):
            return
        time.sleep(1)
    # Do not force-kill a guest whose filesystem shutdown is unverified.
    raise RuntimeError('Staged guest did not power off; refusing disk activation.')


def verify(args, password, port, http_port, manifest):
    ready(args, password, port)
    checks = {}
    def check(name, condition):
        checks[name] = bool(condition)
        if not condition:
            raise RuntimeError('Verification failed: ' + name)
    board = json.loads(ssh(args, password, port, 'ubus call system board'))
    check('openwrt_x86', board.get('release', {}).get('target') == 'x86/64')
    data = json.loads(ssh(args, password, port, 'ubus call freeisp.pppoe get'))
    check('pppoe_rpc_available', 'config' in data and data.get('status', {}).get('available'))
    bridge = json.loads(ssh(args, password, port, '/usr/libexec/freeisp-bridge-status'))
    check('bridge_backend', all(bridge.get(key, {}).get('code') == 0 for key in ('link', 'fdb', 'vlan')))
    interfaces = json.loads(ssh(args, password, port, 'ubus call network.interface dump'))
    check('baseline_interfaces_up', all(any(row.get('interface') == name and row.get('up')
                                           for row in interfaces.get('interface', []))
                                       for name in ('wan', 'lan', 'management')))
    ssh(args, password, port, 'set -eu; fw4 check; test -d /srv/freeisp-files; '
        'test -f /etc/config/freeisp_wifi; /etc/init.d/freeisp-pppoe enabled; '
        '/etc/init.d/freeisp-pppoe running; command -v tc; command -v bridge')
    check('runtime_services_and_firewall', True)
    ssh(args, password, port, 'set -eu; test -x /usr/bin/freeisp-command-line; '
        'sh -n /usr/bin/freeisp-command-line; '
        '/usr/bin/freeisp-command-line routes4 >/dev/null; '
        '/usr/bin/freeisp-command-line routes6 >/dev/null; '
        '/usr/bin/freeisp-command-line log >/dev/null; '
        '/usr/bin/freeisp-command-line ping 127.0.0.1 1 >/dev/null; '
        'if /usr/bin/freeisp-command-line routes4 unexpected >/dev/null 2>&1; then exit 1; fi')
    check('command_line_diagnostics', True)
    base = 'http://127.0.0.1:' + str(http_port)
    with urllib.request.urlopen(base + '/luci-static/freeisp/release.json', timeout=20) as response:
        check('published_revision', json.load(response) == manifest)
    for page in ('bridge', 'command-line', 'files', 'log', 'pppoe', 'queues', 'wifi-profiles', 'wifi-status'):
        with urllib.request.urlopen(base + '/luci-static/resources/view/freeisp/' + page + '.js', timeout=20) as response:
            check('asset_' + page, response.status == 200 and len(response.read()) > 100)
    with urllib.request.urlopen(base + '/cgi-bin/luci/', timeout=30) as response:
        check('luci_responds', response.status == 200 and len(response.read()) > 100)
    return checks


def activate(args, password, state, manifest):
    if state.get('activated'):
        raise RuntimeError('This stage has already been activated.')
    if state.get('disk') != str(args.disk) or state.get('revision') != manifest['revision']:
        raise RuntimeError('Stage disk or release differs from requested activation.')
    if not state.get('ready_for_review'):
        raise RuntimeError('Stage did not complete its prerequisite checks.')
    if state.get('stage_disk') != str(args.backup / 'staged.raw'):
        raise RuntimeError('Unexpected staged disk location.')
    if file_hash(args.backup / 'original.raw') != state.get('backup_sha256'):
        raise RuntimeError('Original full-disk backup verification failed.')
    if state.get('config_before') != configuration_hash(args, password, 2224):
        raise RuntimeError('Live configuration changed during staging; create a fresh stage to preserve it.')
    if not stage_alive(state):
        raise RuntimeError('Expected staged QEMU process is not running.')
    state['checks'] = verify(args, password, 2225, 8892, manifest)
    stop_stage(args, password, state)
    pending = args.disk.with_name(args.disk.name + '.freeisp-next')
    if pending.exists():
        raise RuntimeError('Pending activation file already exists: ' + str(pending))
    live_metadata = args.disk.stat()
    shutil.copy2(state['stage_disk'], pending)
    # The live QEMU service may run as an unprivileged account. The stage runs
    # as root, so copy2 alone would replace a readable live disk with root:root.
    os.chown(pending, live_metadata.st_uid, live_metadata.st_gid)
    os.chmod(pending, stat.S_IMODE(live_metadata.st_mode))
    with pending.open('rb') as stream:
        os.fsync(stream.fileno())
    old = args.disk.with_name(args.disk.name + '.freeisp-previous-' + manifest['revision'][:12])
    if old.exists():
        raise RuntimeError('Previous activation disk already exists: ' + str(old))
    replaced = False
    try:
        try:
            run(['systemctl', 'stop', args.service], timeout=90)
            os.replace(args.disk, old)
            try:
                os.replace(pending, args.disk)
                replaced = True
            except BaseException:
                os.replace(old, args.disk)
                raise
        finally:
            run(['systemctl', 'start', args.service], timeout=90)
        state['live_checks'] = verify(args, password, 2224, 8890, manifest)
    except BaseException:
        if replaced:
            try:
                run(['systemctl', 'stop', args.service], timeout=90)
                failed = args.backup / 'failed-activation.raw'
                shutil.copy2(args.disk, failed)
                os.replace(old, args.disk)
            finally:
                run(['systemctl', 'start', args.service], timeout=90)
            state['rolled_back'] = True
            save(args.backup / 'deployment.json', state)
        raise
    state['activated'] = True
    state['previous_disk'] = str(old)
    save(args.backup / 'deployment.json', state)
    print('Reviewed stage activated; previous disk retained at ' + str(old), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'disk', 'backup', 'credentials', 'guest-known-hosts'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--service', default='freeisp-openwrt.service')
    parser.add_argument('--activate-only', action='store_true', help='Activate existing staged guest after external review.')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Run this helper as root on the Linux QEMU host.')
    for name in ('source', 'disk', 'backup', 'credentials', 'guest_known_hosts'):
        setattr(args, name, getattr(args, name).resolve())
    if not args.disk.is_file() or not args.guest_known_hosts.is_file():
        raise RuntimeError('Existing live disk and trusted guest host-key file are required.')
    if ',' in str(args.backup):
        raise RuntimeError('Backup directory must not contain commas in QEMU drive paths.')
    for program in ('sshpass', 'ssh', 'ssh-keygen', 'qemu-system-x86_64', 'systemctl', 'git'):
        if not shutil.which(program):
            raise RuntimeError('Required host program missing: ' + program)
    run(['ssh-keygen', '-F', '[127.0.0.1]:2224', '-f', str(args.guest_known_hosts)])
    run(['git', '-C', str(args.source), 'diff', '--quiet', 'HEAD', '--'])
    commit = run(['git', '-C', str(args.source), 'rev-parse', 'HEAD']).decode().strip()
    password = json.loads(args.credentials.read_text())['password']
    if not isinstance(password, str) or not password or '\n' in password:
        raise RuntimeError('Credentials must contain a nonempty single-line password.')
    content, manifest, count = overlay(args)
    args.backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.backup.chmod(0o700)
    state_path = args.backup / 'deployment.json'
    if args.activate_only:
        state = json.loads(state_path.read_text())
        if state.get('commit') != commit:
            raise RuntimeError('Activation source commit differs from staged commit.')
        activate(args, password, state, manifest)
        return
    backup = args.backup / 'original.raw'
    stage = args.backup / 'staged.raw'
    if any(path.exists() for path in (backup, stage, state_path)):
        raise RuntimeError('Use a fresh backup directory; existing deployment data is never overwritten.')
    for port in (2225, 8892, 8893, 18879):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    run(['systemctl', 'is-active', '--quiet', args.service])
    ready(args, password, 2224)
    state = {'commit': commit, 'revision': manifest['revision'], 'disk': str(args.disk),
             'stage_disk': str(stage), 'backup_disk': str(backup), 'overlay_files': count,
             'config_before': configuration_hash(args, password, 2224), 'activated': False}
    print('Briefly stopping the live VM to take consistent full-disk copies.', flush=True)
    try:
        ssh(args, password, 2224, 'sync')
        run(['systemctl', 'stop', args.service], timeout=90)
        shutil.copy2(args.disk, backup)
        shutil.copy2(backup, stage)
    finally:
        run(['systemctl', 'start', args.service], timeout=90)
    backup.chmod(0o600)
    stage.chmod(0o600)
    state['backup_sha256'] = file_hash(backup)
    use_kvm = os.access('/dev/kvm', os.R_OK | os.W_OK)
    argv = ['qemu-system-x86_64', '-machine', 'q35', '-accel', 'kvm' if use_kvm else 'tcg',
            '-cpu', 'host' if use_kvm else 'max', '-m', '768', '-smp', '2',
            '-drive', 'file=' + str(stage) + ',format=raw,if=virtio',
            '-netdev', 'user,id=wan,hostfwd=tcp:127.0.0.1:8893-:80',
            '-device', 'virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01',
            '-netdev', 'socket,id=lan,listen=127.0.0.1:18879',
            '-device', 'virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02',
            '-netdev', 'user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:8892-10.78.0.15:80,hostfwd=tcp:127.0.0.1:2225-10.78.0.15:22,restrict=on',
            '-device', 'virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03',
            '-display', 'none', '-monitor', 'none', '-serial', 'file:' + str(args.backup / 'stage-console.log')]
    with (args.backup / 'stage-qemu.log').open('ab') as log:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    state['stage_pid'] = process.pid
    save(state_path, state)
    try:
        ready(args, password, 2225)
        print('Installing signed distribution packages into the isolated stage.', flush=True)
        ssh(args, password, 2225, 'apk update && apk add ' + ' '.join(PACKAGES), timeout=420)
        ssh(args, password, 2225, 'tar -xzf - -C /', content)
        wifi = args.source / 'openwrt/files/etc/config/freeisp_wifi'
        ssh(args, password, 2225, 'if [ ! -e /etc/config/freeisp_wifi ]; then umask 077; cat > /etc/config/freeisp_wifi; else cat >/dev/null; fi', wifi.read_bytes())
        patch = '''import pathlib,re,sys
revision=sys.argv[1]
for theme in ('freeisp','freeisp-night'):
    path=pathlib.Path('/usr/share/ucode/luci/template/themes')/theme/'header.ut'
    text=path.read_text()
    pattern=r'(/luci-static/freeisp/(?:navigation|wifi-navigation)\\.js)(?:\\?[^"\\\'<>\\s]*)?'
    text=re.sub(pattern,lambda m:m[1]+'?v='+revision,text)
    if '/luci-static/freeisp/navigation.js' not in text:
        text=text.replace('</head>','<script defer src="/luci-static/freeisp/navigation.js?v='+revision+'"></script></head>')
    text=re.sub(r'(cascade\\.css)(?:\\?[^"\\\'<>\\s]*)?',lambda m:m[1]+'?v='+revision,text)
    path.write_text(text)
'''
        ssh(args, password, 2225, 'python3 - ' + shlex.quote(manifest['revision']), patch.encode())
        setup = 'set -eu\n' + '\n'.join('/etc/uci-defaults/' + name for name in DEFAULTS)
        setup += '\n/etc/init.d/firewall reload\n/etc/init.d/freeisp-pppoe restart\n/etc/init.d/rpcd restart\n'
        setup += 'rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* /tmp/luci-indexcache.*\nsync\n'
        ssh(args, password, 2225, 'sh -s', setup.encode(), timeout=90)
        state['checks'] = verify(args, password, 2225, 8892, manifest)
        state['ready_for_review'] = True
        save(state_path, state)
    except BaseException:
        state['ready_for_review'] = False
        save(state_path, state)
        try:
            stop_stage(args, password, state)
        except Exception:
            pass
        raise
    print('Stage verified at http://127.0.0.1:8892; live VM remains on its original disk.', flush=True)
    print('Perform browser/packet review, then rerun the same arguments with --activate-only.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Deployment stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
