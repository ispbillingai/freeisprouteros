#!/usr/bin/env python3
"""Reject a wrong password in the existing local PPPoE lab; always restore it."""
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
    args = parser.parse_args()
    password = os.environ.get('FREEISP_LAB_PASSWORD') or getpass.getpass('Router password: ')

    def connect(port):
        c = paramiko.SSHClient()
        c.load_host_keys(str(args.directory / 'guest-known-hosts'))
        c.connect('127.0.0.1', port=port, username='root', password=password,
                  look_for_keys=False, allow_agent=False, timeout=10)
        return c

    def run(c, command):
        _, out, err = c.exec_command(command, timeout=30)
        result = out.read().decode(errors='replace')
        error = err.read().decode(errors='replace')
        if out.channel.recv_exit_status():
            raise RuntimeError(error)
        return result

    router, customer = connect(12224), connect(12225)
    report = {}
    changed = False
    try:
        if run(customer, 'uci changes network').strip():
            raise RuntimeError('Customer has unsaved network changes; refusing to replace them.')
        assert run(customer, 'uci get network.wan.username').strip() == 'lab-customer'
        before = run(router, 'logread -e ppp')
        changed = True
        run(customer, 'uci set network.wan.password=deliberately-wrong-lab-password; ifdown wan; ifup wan')
        for _ in range(30):
            logs = run(router, 'logread -e ppp')
            fresh = logs[len(before):] if logs.startswith(before) else logs
            if 'Peer lab-customer failed CHAP authentication' in fresh:
                break
            time.sleep(1)
        else:
            raise RuntimeError('No new PPPoE rejection log appeared.')
        sessions = json.loads(run(router, 'ubus call freeisp.pppoe status'))['sessions']
        state = json.loads(run(customer, 'ubus call network.interface.wan status'))
        report['wrong_password_rejected'] = not state.get('up') and not any(s['name'] == 'lab-customer' for s in sessions)
        report['router_failure_logs'] = [line for line in fresh.splitlines() if 'failed CHAP authentication' in line]
        report['customer_failure_logs'] = run(customer, 'logread -e "CHAP authentication failed"').splitlines()[-4:]
        assert report['wrong_password_rejected']
        print('PASS: wrong password rejected, no active customer session.', flush=True)
    finally:
        if changed:
            run(customer, 'uci revert network.wan.password; ifdown wan; ifup wan')
        router.close()
        customer.close()
    router, customer = connect(12224), connect(12225)
    try:
        for _ in range(30):
            sessions = json.loads(run(router, 'ubus call freeisp.pppoe status'))['sessions']
            state = json.loads(run(customer, 'ubus call network.interface.wan status'))
            if state.get('up') and any(s['name'] == 'lab-customer' for s in sessions):
                break
            time.sleep(1)
        else:
            raise RuntimeError('Correct password restored but customer did not reconnect.')
        code = run(customer, "curl --interface pppoe-wan -fsS --max-time 20 -o /dev/null -w '%{http_code}' https://downloads.openwrt.org/")
        report['correct_password_restored'] = code == '200'
        assert report['correct_password_restored']
        (args.directory / 'pppoe-auth-results.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        print('PASS: correct password restored; PPPoE customer has internet again.')
    finally:
        router.close()
        customer.close()


if __name__ == '__main__':
    main()
