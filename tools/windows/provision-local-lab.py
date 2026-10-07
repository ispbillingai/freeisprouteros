#!/usr/bin/env python3
"""Provision the two isolated VMs created by create-local-lab.py.

Requires paramiko, FREEISP_LAB_PASSWORD in the environment, and a source
checkout whose HEAD was pushed to GitHub before running this script.
SSH host keys are pinned on the first connection to the new loopback VMs.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
import types
import paramiko


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    password = os.environ['FREEISP_LAB_PASSWORD']
    keys = args.directory / 'guest-known-hosts'
    if not keys.exists():
        keys.touch()

    def connect(port):
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            for candidate in (password, password.replace('@', '\\@')):
                client = paramiko.SSHClient()
                client.load_host_keys(str(keys))
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                try:
                    client.connect('127.0.0.1', port=port, username='root', password=candidate,
                                   allow_agent=False, look_for_keys=False, timeout=5,
                                   auth_timeout=10, banner_timeout=10)
                    client.save_host_keys(str(keys))
                    return client
                except paramiko.BadHostKeyException:
                    raise
                except (OSError, paramiko.SSHException):
                    client.close()
            time.sleep(2)
        raise RuntimeError('Local lab SSH did not become ready on port ' + str(port))

    def run(client, command, data=None, timeout=90):
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        if data is not None:
            stdin.write(data)
        stdin.channel.shutdown_write()
        out = stdout.read().decode(errors='replace')
        err = stderr.read().decode(errors='replace')
        if stdout.channel.recv_exit_status():
            raise RuntimeError(command.splitlines()[0] + ': ' + err[-1800:])
        return out

    print('Connecting to isolated lab VMs...', flush=True)
    router = connect(12224)
    customer = connect(12225)
    try:
        for client in (router, customer):
            run(client, 'passwd root', password + '\n' + password + '\n')
        run(router, "uci set system.@system[0].hostname='FreeISP-Lab'; uci commit system; /etc/init.d/system reload")
        # A cloned router must not retain the same local subnet as its uplink.
        run(customer, '''set -eu
uci set system.@system[0].hostname='FreeISP-Customer'
uci set network.lan.ipaddr='10.88.0.1'
uci set dhcp.lan.ignore='1'
uci set dhcp.freeisp.ip='10.77.0.1'
uci commit
/etc/init.d/system reload
/etc/init.d/dnsmasq restart
/etc/init.d/network reload
''')
        print('Customer network separated; installing router feature packages...', flush=True)
        spec = importlib.util.spec_from_file_location('reviewed', source / 'tools/openwrt/deploy-reviewed.py')
        reviewed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reviewed)
        run(router, 'apk update && apk add ' + ' '.join(reviewed.PACKAGES), timeout=420)
        content, manifest, count = reviewed.overlay(types.SimpleNamespace(source=source))
        run(router, 'tar -xzf - -C /', content)
        for name in ('freeisp_wifi', 'freeisp_tools', 'freeisp_api', 'freeisp_ftp'):
            path = '/etc/config/' + name
            run(router, 'if [ ! -e ' + path + ' ]; then umask 077; cat > ' + path + '; else cat >/dev/null; fi',
                (source / 'openwrt/files/etc/config' / name).read_bytes())
        # First-boot templates already load navigation.js; refresh their URL.
        patch = """import pathlib,re,sys
for theme in ('freeisp','freeisp-night'):
    p=pathlib.Path('/usr/share/ucode/luci/template/themes')/theme/'header.ut'
    s=p.read_text()
    s=re.sub(r'(/luci-static/freeisp/navigation\\.js)(?:\\?[^\"<>\\s]*)?',lambda m:m[1]+'?v='+sys.argv[1],s)
    p.write_text(s)
"""
        run(router, 'python3 - ' + manifest['revision'], patch)
        setup = 'set -eu\n' + '\n'.join('/etc/uci-defaults/' + name for name in reviewed.DEFAULTS)
        setup += '\n/etc/init.d/firewall reload\n'
        setup += '\n'.join('/etc/init.d/' + name + ' restart' for name in (
            'freeisp-pppoe', 'freeisp-hotspot', 'freeisp-tools', 'freeisp-api', 'freeisp-ftp', 'rpcd'))
        setup += '\nrm -f /tmp/luci-indexcache /tmp/luci-modulecache/* /tmp/luci-indexcache.*\nsync\n'
        run(router, 'sh -s', setup, timeout=120)
        print('Published overlay installed: ' + str(count) + ' files. Checking real customer traffic...', flush=True)
        for attempt in range(30):
            state = json.loads(run(customer, 'ubus call network.interface.wan status'))
            if state.get('up') and state.get('ipv4-address'):
                break
            time.sleep(2)
        report = {
            'router': json.loads(run(router, 'ubus call system board')),
            'customer_wan': state,
            'customer_routes': run(customer, 'ip route'),
            'leases': run(router, 'cat /tmp/dhcp.leases'),
            'dns': run(customer, 'nslookup downloads.openwrt.org 10.77.0.1'),
            'https': run(customer, "curl -fsS --max-time 30 -o /dev/null -w '%{http_code}' https://downloads.openwrt.org/"),
            'router_rpc': run(router, 'ubus list freeisp.*'),
            'revision': manifest['revision'],
        }
        (args.directory / 'validation.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2), flush=True)
    finally:
        router.close()
        customer.close()


if __name__ == '__main__':
    main()
