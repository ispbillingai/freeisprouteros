"""Functional TCP tests for the production API with a simulated authenticated ubus.

Run: python tools/openwrt/test-api-service.py
The socket server, framing, command mapping, limits and helper process boundary are
real; platform responses are fixtures. Router/ucode integration remains a separate
on-device check, not claimed by these tests.
"""

from pathlib import Path
import json
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'openwrt/files/usr/lib/freeisp'))
from api_protocol import SentenceDecoder, encode_length, encode_sentence
from api_server import ApiError, ApiServer, OpenWrtBackend


class Platform(OpenWrtBackend):
    def __init__(self):
        self.calls = []
        self.sessions = set()
        self.hostname = 'FreeISP'
        self.logouts = []

    def request(self, action, **params):
        self.calls.append((action, params))
        if action == 'login':
            if params['username'] != 'root' or params['password'] != 'test-only-password':
                raise ApiError('Authentication denied')
            session = f'{len(self.calls):032x}'
            self.sessions.add(session)
            return {'session': session}
        session = params['session']
        if session not in self.sessions:
            raise ApiError('Authentication expired')
        if action == 'destroy':
            self.sessions.remove(session)
            self.logouts.append(session)
            return {}
        if action == 'identity-set':
            self.hostname = params['name']
            return {}
        obj, method, args = params['object'], params['method'], params['params']
        if (obj, method) == ('system', 'board'):
            return {'hostname': self.hostname, 'model': 'Fixture board', 'release': {'version': '24.10.5', 'target': 'x86/64'}}
        if (obj, method) == ('system', 'info'):
            return {'uptime': 90061, 'memory': {'free': 1234, 'total': 8192}}
        if (obj, method) == ('network.device', 'status'):
            return {'eth0': {'type': 'Network device', 'up': True, 'carrier': True, 'mtu': 1500,
                             'macaddr': '52:54:00:00:00:01', 'statistics': {'rx_bytes': 42}},
                    'br-lan': {'type': 'bridge', 'up': True, 'bridge-members': ['eth0'], 'mtu': 1500},
                    'eth0.20': {'type': 'Network device', 'up': True, 'mtu': 1500}}
        if (obj, method) == ('network.interface', 'dump'):
            return {'interface': [{'interface': 'lan', 'l3_device': 'br-lan', 'up': True,
                                   'ipv4-address': [{'address': '10.77.0.1', 'mask': 24}],
                                   'route': [{'target': '0.0.0.0', 'mask': 0, 'nexthop': '10.77.0.254'}],
                                   'dns-server': ['1.1.1.1', '9.9.9.9']}]}
        if (obj, method) == ('service', 'list'):
            return {name: {'instances': {'main': {'running': name != 'freeisp-ftp'}}}
                    for name in ['freeisp-api', 'freeisp-ftp', 'dropbear', 'uhttpd']}
        if (obj, method) == ('uci', 'get'):
            configs = {
                'network': {'bridge': {'.type': 'device', 'name': 'br-lan', 'type': 'bridge'},
                            'vlan': {'.type': 'device', 'name': 'eth0.20', 'type': '8021q', 'vid': '20', 'ifname': 'eth0'},
                            'lan': {'.type': 'interface', 'dns': ['1.1.1.1']}},
                'freeisp_api': {'main': {'.type': 'service', 'port': '8728', 'enabled': '1'}},
                'freeisp_ftp': {'main': {'.type': 'service', 'port': '21', 'enabled': '0'}},
                'dropbear': {'main': {'.type': 'dropbear', 'Port': '22'}},
                'uhttpd': {'main': {'.type': 'uhttpd', 'listen_http': ['10.78.0.15:80'], 'listen_https': ['0.0.0.0:443']}}}
            return {'values': configs[args['config']]}
        if (obj, method) == ('file', 'list'):
            if args != {'path': '/srv/freeisp/files'}:
                raise AssertionError('File path must be fixed')
            return {'entries': [{'name': 'router.backup', 'size': 1024, 'type': 'file'}]}
        raise AssertionError((obj, method, args))


class Client:
    def __init__(self, address):
        self.socket = socket.create_connection(address, timeout=2)
        self.decoder = SentenceDecoder()
        self.pending = []

    def close(self):
        self.socket.close()

    def send(self, *words):
        self.socket.sendall(encode_sentence([word.encode() for word in words]))

    def read(self):
        while not self.pending:
            data = self.socket.recv(65536)
            if not data:
                return None
            self.pending.extend(self.decoder.feed(data))
        return [word.decode() for word in self.pending.pop(0)]

    def command(self, *words):
        self.send(*words)
        result = []
        while True:
            sentence = self.read()
            if sentence is None:
                return result
            result.append(sentence)
            if sentence[0] in ('!done', '!fatal'):
                return result

    def login(self):
        result = self.command('/login', '=name=root', '=password=test-only-password')
        assert result == [['!done']], result


def row(sentence):
    return {word[1:].split('=', 1)[0]: word[1:].split('=', 1)[1] for word in sentence if word.startswith('=')}


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.backend = Platform()
        self.server = ApiServer(('127.0.0.1', 0), backend=self.backend, max_clients=2, sentence_timeout=2)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.client = Client(self.server.server_address)

    def tearDown(self):
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def test_no_reads_or_writes_before_authentication(self):
        for command in [('/system/resource/print',), ('/system/identity/set', '=name=Hacked')]:
            result = self.client.command(*command, '.tag=unauth')
            self.assertEqual(result[0][0], '!trap')
            self.assertIn('=message=Authentication required', result[0])
            self.assertEqual(result[-1], ['!done', '.tag=unauth'])
        self.assertEqual(self.backend.calls, [])

    def test_login_failures_never_grant_access_and_close_after_three(self):
        for _ in range(3):
            self.assertEqual(self.client.command('/login', '=name=root', '=password=wrong')[0][0], '!trap')
        self.assertIsNone(self.client.read())
        self.assertFalse(self.backend.sessions)
        self.assertEqual({action for action, _ in self.backend.calls}, {'login'})

    def test_non_root_and_empty_password_rejected_before_platform_call(self):
        for attrs in [('=name=admin', '=password=anything'), ('=name=root', '=password=')]:
            self.assertEqual(self.client.command('/login', *attrs)[0][0], '!trap')
        self.assertEqual(self.backend.calls, [])

    def test_login_tag_and_fragmented_framing(self):
        packet = encode_sentence([b'/login', b'=name=root', b'=password=test-only-password', b'.tag=auth'])
        for byte in packet:
            self.client.socket.sendall(bytes([byte]))
        self.assertEqual(self.client.read(), ['!done', '.tag=auth'])
        result = self.client.command('/system/resource/print', '=.proplist=uptime,platform', '.tag=resource')
        self.assertEqual(row(result[0]), {'uptime': '1d01:01:01', 'platform': 'FreeISP OpenWrt'})
        self.assertEqual(result[-1], ['!done', '.tag=resource'])
        self.assertIn('.tag=resource', result[0])

    def test_pipelined_commands_keep_tags_separate(self):
        self.client.login()
        self.client.send('/system/identity/print', '.tag=one')
        self.client.send('/system/resource/print', '.tag=two')
        responses = [self.client.read() for _ in range(4)]
        self.assertEqual([sentence[-1] for sentence in responses], ['.tag=one', '.tag=one', '.tag=two', '.tag=two'])

    def test_query_equality_existence_and_absence(self):
        self.client.login()
        result = self.client.command('/interface/print', '?name=eth0', '?mac-address', '?-vlan-id', '=.proplist=name,mtu')
        self.assertEqual(row(result[0]), {'name': 'eth0', 'mtu': '1500'})
        self.assertEqual(len(result), 2)
        self.assertEqual(self.client.command('/interface/print', '?=name=missing'), [['!done']])

    def test_unsupported_query_rejected_before_read(self):
        self.client.login()
        count = len(self.backend.calls)
        for query in ['?#|', '?<mtu=1501', '?>mtu=1400', '?name~eth']:
            self.assertEqual(self.client.command('/interface/print', query)[0][0], '!trap')
        self.assertEqual(len(self.backend.calls), count)

    def test_unknown_command_and_unsupported_print_options_trap(self):
        self.client.login()
        for words in [('/system/reboot',), ('/ppp/secret/print',), ('/file/print', '=path=/etc'),
                      ('/interface/print', '=follow='), ('/interface/print', '=.proplist=name', '=.proplist=type')]:
            result = self.client.command(*words)
            self.assertEqual([sentence[0] for sentence in result], ['!trap', '!done'])

    def test_identity_write_is_persisted_via_authenticated_backend(self):
        self.client.login()
        self.assertEqual(self.client.command('/system/identity/set', '=name=Branch-2'), [['!done']])
        self.assertEqual(row(self.client.command('/system/identity/print')[0]), {'name': 'Branch-2'})
        writes = [params for action, params in self.backend.calls if action == 'identity-set']
        self.assertEqual(len(writes), 1)
        self.assertIn(writes[0]['session'], self.backend.sessions)
        for name in ['-bad', 'a;reboot', 'a\nname', 'x' * 64]:
            self.assertEqual(self.client.command('/system/identity/set', '=name=' + name)[0][0], '!trap')
        self.assertEqual(len([x for x in self.backend.calls if x[0] == 'identity-set']), 1)

    def test_expired_session_cannot_read_or_write(self):
        self.client.login()
        self.backend.sessions.clear()
        for words in [('/system/identity/print',), ('/system/identity/set', '=name=Denied')]:
            self.assertEqual(self.client.command(*words)[0][0], '!trap')
        self.assertEqual(self.backend.hostname, 'FreeISP')

    def test_interface_subsets(self):
        self.client.login()
        for kind, expected in [('ethernet', 'eth0'), ('bridge', 'br-lan'), ('vlan', 'eth0.20')]:
            result = self.client.command(f'/interface/{kind}/print')
            self.assertEqual(row(result[0])['name'], expected)
            self.assertEqual(len(result), 2)

    def test_addresses_routes_dns_and_files(self):
        self.client.login()
        address = row(self.client.command('/ip/address/print')[0])
        self.assertEqual((address['address'], address['network'], address['interface']), ('10.77.0.1/24', '10.77.0.0', 'br-lan'))
        route = row(self.client.command('/ip/route/print')[0])
        self.assertEqual((route['dst-address'], route['gateway']), ('0.0.0.0/0', '10.77.0.254'))
        self.assertEqual(row(self.client.command('/ip/dns/print')[0]), {'servers': '1.1.1.1', 'dynamic-servers': '9.9.9.9'})
        self.assertEqual(row(self.client.command('/file/print')[0])['name'], 'router.backup')

    def test_ip_services_use_configured_ports_and_real_runtime(self):
        self.client.login()
        result = [row(sentence) for sentence in self.client.command('/ip/service/print')[:-1]]
        api = next(item for item in result if item['name'] == 'api')
        ftp = next(item for item in result if item['name'] == 'ftp')
        self.assertEqual((api['port'], api['running']), ('8728', 'true'))
        self.assertEqual((ftp['port'], ftp['disabled'], ftp['running']), ('21', 'true', 'false'))
        self.assertEqual({x['port'] for x in result if x['name'] == 'freeisp-desk'}, {'80', '443'})

    def test_oversized_word_is_fatal_without_platform_access(self):
        self.client.socket.sendall(encode_length(8193))
        self.assertEqual(self.client.read()[0], '!fatal')
        self.assertIsNone(self.client.read())
        self.assertEqual(self.backend.calls, [])

    def test_invalid_utf8_rejected(self):
        self.client.socket.sendall(encode_sentence([b'/login', b'=name=\xff']))
        self.assertEqual(self.client.read()[0], '!trap')
        self.assertEqual(self.backend.calls, [])

    def test_sentence_deadline_stops_trickle_input(self):
        self.server.sentence_timeout = 0.15
        self.client.close()
        self.client = Client(self.server.server_address)
        self.client.socket.sendall(b'\x20/partial')
        time.sleep(0.25)
        self.assertIsNone(self.client.read())

    def test_concurrency_limit_closes_excess_connection(self):
        self.client.login()
        second = Client(self.server.server_address)
        try:
            second.login()
            third = Client(self.server.server_address)
            try:
                self.assertIsNone(third.read())
            finally:
                third.close()
        finally:
            second.close()

    def test_logout_destroys_owned_rpc_session(self):
        self.client.login()
        self.client.close()
        for _ in range(100):
            if self.backend.logouts:
                break
            time.sleep(0.005)
        self.assertEqual(len(self.backend.logouts), 1)
        self.assertFalse(self.backend.sessions)

    def test_global_login_rate_limit(self):
        now = time.monotonic()
        self.server.login_limiter.attempts.extend([now] * 20)
        result = self.client.command('/login', '=name=root', '=password=test-only-password')
        self.assertIn('=message=Too many login attempts; try later', result[0])
        self.assertEqual(self.backend.calls, [])
        self.assertIsNone(self.client.read())


class ProcessBoundaryTests(unittest.TestCase):
    def test_password_and_session_are_only_in_stdin(self):
        backend = OpenWrtBackend()
        with patch('api_server.subprocess.run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps({'ok': True, 'result': {'session': '1' * 32}}).encode())
            backend.login('root', 'not-a-real-password')
            args, kwargs = run.call_args
            self.assertEqual(args[0], ['/usr/bin/ucode', '/usr/lib/freeisp/api_ubus.uc'])
            self.assertNotIn('env', kwargs)
            self.assertNotIn('shell', kwargs)
            self.assertEqual(json.loads(kwargs['input'])['password'], 'not-a-real-password')
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)

    def test_helper_error_and_timeout_fail_closed(self):
        for output in [b'not-json', b'{"ok":false,"error":"secret"}', b'{}']:
            with patch('api_server.subprocess.run', return_value=subprocess.CompletedProcess([], 0, output)):
                with self.assertRaises(ApiError) as error:
                    OpenWrtBackend().login('root', 'unused')
                self.assertNotIn('secret', str(error.exception))
        with patch('api_server.subprocess.run', side_effect=subprocess.TimeoutExpired('ucode', 20)):
            with self.assertRaises(ApiError):
                OpenWrtBackend().login('root', 'unused')


if __name__ == '__main__':
    unittest.main(verbosity=2)
