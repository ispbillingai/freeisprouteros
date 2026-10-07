"""Exercise real ucode/ubus/rpcd in an existing disposable OpenWrt rootfs.

Installs TEST-ONLY credentials and fixtures in the named /tmp rootfs; never point
this at a router. Requires ucode-mod-ubus, ucode-mod-fs and rpcd-mod-file.
  python tools/openwrt/test-api-platform.py --rootfs /tmp/freeisp-api-test --distro docker-desktop
No packages are downloaded and no device is contacted by this test.
"""

import argparse
import json
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rootfs', required=True)
    parser.add_argument('--distro', required=True)
    parser.add_argument('--debug', action='store_true', help='Show helper exceptions for disposable fixture diagnostics')
    args = parser.parse_args()
    if not re.fullmatch(r'/tmp/freeisp-[a-zA-Z0-9_-]+', args.rootfs):
        parser.error('rootfs must be a disposable /tmp/freeisp-* directory')
    base = ['wsl', '-d', args.distro, '--', 'chroot', args.rootfs]

    def run(argv, content=None):
        result = subprocess.run(base + argv, input=content.encode() if content is not None else None,
                                capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors='replace'))
        return result.stdout.decode()

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'openwrt/files/usr/lib/freeisp'))
    from api_protocol import SentenceDecoder, encode_sentence
    for source, dest in [('openwrt/files/usr/lib/freeisp/api_server.py', '/usr/lib/freeisp/api_server.py'),
                         ('openwrt/files/usr/lib/freeisp/api_protocol.py', '/usr/lib/freeisp/api_protocol.py'),
                         ('openwrt/files/usr/lib/freeisp/api_ubus.uc', '/usr/lib/freeisp/api_ubus.uc'),
                         ('openwrt/files/usr/share/rpcd/acl.d/freeisp-api.json', '/usr/share/rpcd/acl.d/freeisp-api.json')]:
        source_text = (root / source).read_text()
        if args.debug and source.endswith('.uc'):
            source_text = source_text.replace('code: failure_code', 'code: failure_code, detail: e')
        run(['/bin/sh'], "mkdir -p '" + dest.rsplit('/', 1)[0] + "'\ncat > '" + dest + "' <<'API_TEST_FILE_EOF'\n" +
            source_text + '\nAPI_TEST_FILE_EOF\n')
    password = 'FreeISP-disposable-test-only-2026'
    # Intentionally public disposable fixture credential, not a user secret.
    run(['/bin/sh'], '''set -eu
mkdir -p /var/run/ubus /var/run/rpcd /tmp /srv/freeisp/files
hash=$(/usr/sbin/uhttpd -m FreeISP-disposable-test-only-2026)
awk -F: -v hash="$hash" 'BEGIN {OFS=":"} $1=="root" {$2=hash} {print}' /etc/shadow > /tmp/shadow.test
cat /tmp/shadow.test > /etc/shadow
rm /tmp/shadow.test
cat > /etc/config/system <<'EOF'
config system 'main'
 option hostname 'FreeISP-Test'
EOF
printf 'fixture file\\n' > /srv/freeisp/files/api-test.txt
# A chroot shares the host kernel. Replace this test rootfs's reload with a
# recording stub so the test can never change the WSL host hostname/sysctls.
cat > /etc/init.d/system <<'EOF'
#!/bin/sh
printf '%s\\n' "$1" > /tmp/api-test-system-reload
exit 0
EOF
chmod 755 /etc/init.d/system
''')
    # Keep WSL launchers alive. Background children of a completed WSL command
    # may be terminated by the desktop host even though they were daemonized.
    processes = []

    def start(name, command):
        process = subprocess.Popen(base + ['/bin/sh'], stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        script = 'echo $$ > /tmp/api-test-' + name + '.pid\nexec ' + shlex.join(command) + '\n'
        process.stdin.write(script.encode())
        process.stdin.close()
        processes.append((name, process))
        return process

    start('ubusd', ['/sbin/ubusd', '-s', '/var/run/ubus/ubus.sock'])
    time.sleep(0.2)
    start('rpcd', ['/sbin/rpcd', '-s', '/var/run/ubus/ubus.sock'])
    time.sleep(0.4)

    def helper(**request):
        output = run(['/usr/bin/ucode', '/usr/lib/freeisp/api_ubus.uc'], json.dumps(request))
        return json.loads(output)

    try:
        for request in [dict(action='login', username='root', password='wrong'),
                        dict(action='login', username='admin', password=password),
                        dict(action='login', username='root', password=''),
                        dict(action='call', session='0' * 32, object='uci', method='get', params={'config': 'system'})]:
            assert helper(**request)['ok'] is False, request['action']
        login = helper(action='login', username='root', password=password)
        assert login['ok'], login
        sid = login['result']['session']
        config = helper(action='call', session=sid, object='uci', method='get', params={'config': 'system'})
        assert config['result']['values']['main']['hostname'] == 'FreeISP-Test', config
        denied = helper(action='call', session=sid, object='file', method='read', params={'path': '/etc/shadow'})
        assert denied['ok'] is False, denied
        listing = helper(action='call', session=sid, object='file', method='list', params={'path': '/srv/freeisp/files'})
        assert listing['ok'] and any(entry['name'] == 'api-test.txt' for entry in listing['result']['entries']), listing
        assert helper(action='identity-set', session=sid, name='bad;name')['ok'] is False
        changed = helper(action='identity-set', session=sid, name='FreeISP-Test-Changed')
        assert changed['ok'], changed
        assert run(['/bin/cat', '/tmp/api-test-system-reload']).strip() == 'reload'
        config = helper(action='call', session=sid, object='uci', method='get', params={'config': 'system'})
        assert config['result']['values']['main']['hostname'] == 'FreeISP-Test-Changed', config
        assert helper(action='destroy', session=sid)['ok']
        assert helper(action='call', session=sid, object='uci', method='get', params={'config': 'system'})['ok'] is False
        print('Real OpenWrt helper: login denial/success, root-only access, ACLs, restricted files, identity commit and expired-session rejection passed.')
        print('Identity reload invocation verified with recording stub; no host system settings changed.')
        api = start('server', ['/usr/bin/python3', '-B', '/usr/lib/freeisp/api_server.py',
                               '--listen-address', '127.0.0.1', '--port', '18728'])
        time.sleep(0.5)
        assert api.poll() is None, 'Test API failed to start'
        with socket.create_connection(('127.0.0.1', 18728), timeout=3) as client:
            decoder = SentenceDecoder()

            def command(*words):
                client.sendall(encode_sentence([word.encode() for word in words]))
                replies = []
                while not replies or replies[-1][0] != b'!done':
                    data = client.recv(65536)
                    assert data, 'API unexpectedly closed'
                    replies.extend(decoder.feed(data))
                return replies

            assert command('/file/print')[0][0] == b'!trap'
            assert command('/login', '=name=root', '=password=wrong')[0][0] == b'!trap'
            assert command('/login', '=name=root', '=password=' + password) == [[b'!done']]
            files = command('/file/print', '?name=api-test.txt', '=.proplist=name,size', '.tag=files')
            assert files[0][0] == b'!re' and b'=name=api-test.txt' in files[0] and b'.tag=files' in files[0], files
            assert files[-1] == [b'!done', b'.tag=files'], files
            assert command('/system/identity/set', '=name=FreeISP-Socket-Test') == [[b'!done']]
            assert command('/unsupported/print')[0][0] == b'!trap'
        print('End-to-end TCP API on OpenWrt Python: authentication, real file listing, filters/tags, identity mutation and unsupported-command trap passed.')
    finally:
        for name, process in reversed(processes):
            # WSL launcher termination alone can leave its Linux child alive.
            # Kill only the recorded PID whose actual root matches our fixture.
            cleanup = 'pid=$(cat ' + args.rootfs + '/tmp/api-test-' + name + '.pid)\n'
            cleanup += 'if [ "$(readlink /proc/$pid/root)" = ' + args.rootfs + ' ]; then kill "$pid"; fi\n'
            subprocess.run(['wsl', '-d', args.distro, '--', '/bin/sh'], input=cleanup.encode(),
                           capture_output=True, timeout=5, check=True)
            process.wait(timeout=5)


if __name__ == '__main__':
    main()
