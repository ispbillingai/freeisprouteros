#!/usr/bin/env python3
"""Create a 1 Mbps PPPoE customer in the isolated local lab and measure both directions.

Uses the product's normal configuration API. Leaves the server and customer
connected. Test payloads are generated locally and never sent to third parties.
"""
import argparse
import copy
import getpass
import http.server
import json
import os
from pathlib import Path
import secrets
import shlex
import threading
import time
import paramiko

SIZE = 4 * 1024 * 1024


class Witness(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        body = b'FreeISP local WAN witness\n' if self.path == '/' else b'x' * SIZE
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length != SIZE:
            self.send_error(400)
            return
        start = time.monotonic()
        received = 0
        while received < length:
            block = self.rfile.read(min(16384, length - received))
            if not block:
                break
            received += len(block)
        elapsed = time.monotonic() - start
        body = json.dumps({'bytes': received, 'seconds': elapsed,
                           'mbps': received * 8 / elapsed / 1000000}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    password = os.environ.get('FREEISP_LAB_PASSWORD') or getpass.getpass('Router password: ')

    def connect(port):
        client = paramiko.SSHClient()
        client.load_host_keys(str(args.directory / 'guest-known-hosts'))
        client.connect('127.0.0.1', port=port, username='root', password=password,
                       look_for_keys=False, allow_agent=False, timeout=10)
        return client

    def run(client, command, data=None, timeout=45):
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        if data is not None:
            stdin.write(data)
        stdin.channel.shutdown_write()
        output = stdout.read().decode(errors='replace')
        error = stderr.read().decode(errors='replace')
        if stdout.channel.recv_exit_status():
            raise RuntimeError(error or output)
        return output

    router = connect(12224)
    customer = connect(12225)
    witness = http.server.ThreadingHTTPServer(('127.0.0.1', 18978), Witness)
    threading.Thread(target=witness.serve_forever, daemon=True).start()
    report = {'profile': 'Lab-1Mbps', 'limit_kbps_each_direction': 1000}

    def rpc(method, data=None):
        result = json.loads(run(router, 'ubus call freeisp.pppoe ' + method + ' "$(cat)"', json.dumps(data or {})))
        if result.get('error'):
            raise RuntimeError('PPPoE API: ' + str(result['error']))
        return result

    try:
        # Ensure the speed-test endpoint lies beyond the router's WAN before changing the client.
        assert 'WAN witness' in run(router, 'curl -fsS --max-time 8 http://10.0.2.2:18978/')
        current = rpc('get')
        config = copy.deepcopy(current['config'])
        account_password = secrets.token_urlsafe(18)
        entries = {
            'pools': {'id': '1ab000000001', 'name': 'Lab-PPPoE-Pool', 'start': '10.81.0.10', 'end': '10.81.0.20'},
            'profiles': {'id': '1ab000000002', 'name': 'Lab-1Mbps', 'local_ip': '10.81.0.1',
                         'pool': '1ab000000001', 'dns1': '1.1.1.1', 'dns2': '8.8.8.8', 'download': 1000, 'upload': 1000},
            'servers': {'id': '1ab000000003', 'name': 'FreeISP-Lab-PPPoE', 'interface': 'br-lan',
                        'profile': '1ab000000002', 'enabled': True, 'mtu': 1492, 'max_sessions': 10},
            'secrets': {'id': '1ab000000004', 'name': 'lab-customer', 'server': '1ab000000003',
                        'profile': '1ab000000002', 'password': account_password, 'remote_ip': '', 'enabled': True},
        }
        for kind, entry in entries.items():
            config[kind] = [row for row in config[kind] if row['id'] != entry['id']] + [entry]
        (args.directory / 'pppoe-config-before-test.json').write_text(json.dumps(current, indent=2))
        saved = rpc('save', {'config': config, 'revision': current['revision']})
        assert any(row['id'] == entries['servers']['id'] and row.get('running') for row in saved['status']['servers']), saved['status']
        print('Created FreeISP-Lab-PPPoE on br-lan with Lab-1Mbps (1000 kbps up/down).', flush=True)
        command = '''set -eu
uci set network.wan.proto=pppoe
uci set network.wan.username=lab-customer
uci set network.wan.password=''' + shlex.quote(account_password) + '''
uci set network.wan.service=FreeISP-Lab-PPPoE
uci set network.wan.ipv6=0
uci set network.wan.mtu=1492
uci commit network
ifdown wan
ifup wan
'''
        run(customer, 'sh -s', command)
        for _ in range(45):
            active = rpc('status')
            session = next((row for row in active.get('sessions', []) if row.get('name') == 'lab-customer'), None)
            state = json.loads(run(customer, 'ubus call network.interface.wan status'))
            if session and state.get('up') and state.get('proto') == 'pppoe':
                break
            time.sleep(1)
        else:
            raise RuntimeError('PPPoE did not connect. ' + run(customer, 'logread -e ppp | tail -25'))
        print('Customer authenticated over PPPoE at ' + session['address'], flush=True)
        report['session_before'] = session
        report['customer_wan'] = state
        report['routes'] = run(customer, 'ip route')
        target = shlex.quote(session['interface'])
        report['download_shaper'] = run(router, 'tc -s qdisc show dev ' + target)
        report['upload_policer'] = run(router, 'tc -s filter show dev ' + target + ' parent ffff:')
        assert 'rate 1Mbit' in report['download_shaper'] or 'rate 1000Kbit' in report['download_shaper']
        assert 'rate 1Mbit' in report['upload_policer'] or 'rate 1000Kbit' in report['upload_policer']
        report['internet_http_status'] = run(customer, "curl --interface pppoe-wan -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://downloads.openwrt.org/")
        assert report['internet_http_status'] == '200'
        print('Internet through PPPoE passed. Measuring a 4 MiB download...', flush=True)
        measured = run(customer, "curl --interface pppoe-wan -fsS --max-time 120 -o /dev/null -w '%{speed_download} %{size_download} %{time_total}' http://10.0.2.2:18978/payload", timeout=130).split()
        report['download'] = {'mbps': float(measured[0]) * 8 / 1000000, 'bytes': int(measured[1]), 'seconds': float(measured[2])}
        print('Download: %.3f Mbps. Measuring a 4 MiB upload...' % report['download']['mbps'], flush=True)
        result = run(customer, 'head -c ' + str(SIZE) + ' /dev/zero | curl --interface pppoe-wan -fsS --max-time 180 --data-binary @- http://10.0.2.2:18978/upload', timeout=190)
        report['upload'] = json.loads(result)
        report['session_after'] = next(row for row in rpc('status')['sessions'] if row['name'] == 'lab-customer')
        report['final_qdisc'] = run(router, 'tc -s qdisc show dev ' + target)
        report['final_policer'] = run(router, 'tc -s filter show dev ' + target + ' parent ffff:')
        # Token buckets permit brief bursts; this checks the sustained payload rate over 4 MiB.
        report['passed'] = all(report[direction]['bytes'] == SIZE and 0 < report[direction]['mbps'] <= 1.05
                               for direction in ('download', 'upload'))
        (args.directory / 'pppoe-1mbps-results.json').write_text(json.dumps(report, indent=2))
        print(json.dumps({'download': report['download'], 'upload': report['upload'], 'passed': report['passed']}, indent=2), flush=True)
        if not report['passed']:
            raise RuntimeError('Measured traffic did not meet the configured sustained speed ceiling.')
        print('PASS. Server, 1 Mbps profile, and customer remain connected for your testing.', flush=True)
    finally:
        witness.shutdown()
        witness.server_close()
        router.close()
        customer.close()


if __name__ == '__main__':
    main()
