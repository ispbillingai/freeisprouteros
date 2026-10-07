#!/usr/bin/env python3
"""Test a real customer behind the local router and generate visible LAN traffic."""
import argparse
import getpass
import json
import os
from pathlib import Path
import time
import paramiko


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=20, choices=range(1, 301), metavar='1..300')
    args = parser.parse_args()
    password = os.environ.get('FREEISP_LAB_PASSWORD') or getpass.getpass('Router password: ')

    def connect(port):
        client = paramiko.SSHClient()
        client.load_host_keys(str(args.directory / 'guest-known-hosts'))
        client.connect('127.0.0.1', port=port, username='root', password=password,
                       look_for_keys=False, allow_agent=False, timeout=10)
        return client

    def run(client, command, timeout=45):
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        output = stdout.read().decode(errors='replace')
        error = stderr.read().decode(errors='replace')
        if stdout.channel.recv_exit_status():
            raise RuntimeError(error or output)
        return output

    router = connect(12224)
    customer = connect(12225)
    try:
        for attempt in range(30):
            state = json.loads(run(customer, 'ubus call network.interface.wan status'))
            if state.get('up') and state.get('ipv4-address'):
                break
            time.sleep(2)
        else:
            raise RuntimeError('Customer did not receive an address from the router within 60 seconds.')
        print('Customer address:', state.get('ipv4-address'))
        print(run(customer, 'ip route'))
        print(run(customer, 'nslookup downloads.openwrt.org 10.77.0.1'))
        code = run(customer, "curl -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://downloads.openwrt.org/")
        if code.strip() != '200':
            raise RuntimeError('Unexpected internet response: ' + code)
        print('PASS: customer internet through FreeISP.', flush=True)
        before = int(run(router, 'cat /sys/class/net/eth1/statistics/rx_bytes'))
        run(router, 'iperf3 -s -B 10.77.0.1 -1 -D --pidfile /tmp/freeisp-lab-iperf.pid')
        print('Generating 5 Mbps of LAN traffic. Watch Interfaces in FreeISP Desk...', flush=True)
        result = json.loads(run(customer, 'iperf3 -c 10.77.0.1 -b 5M -t ' + str(args.seconds) + ' -J', args.seconds + 30))
        if 'error' in result:
            raise RuntimeError(result['error'])
        after = int(run(router, 'cat /sys/class/net/eth1/statistics/rx_bytes'))
        report = {
            'customer_address': state.get('ipv4-address'),
            'internet_http_status': code,
            'duration_seconds': args.seconds,
            'received_mbps': result['end']['sum_received']['bits_per_second'] / 1000000,
            'router_lan_received_bytes': after - before,
        }
        if after <= before:
            raise RuntimeError('Router traffic counters did not advance.')
        (args.directory / 'last-customer-test.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        print('PASS: real traffic reached the router and its counters increased.')
    finally:
        router.close()
        customer.close()


if __name__ == '__main__':
    main()
