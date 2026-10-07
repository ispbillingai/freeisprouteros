"""Real Linux nftables/packet tests; run this file through unshare -n as root.

The disposable network namespace contains both client and destination addresses.
All interfaces and nft rules disappear when the namespace exits. No host rules,
network adapters, routes or firewall state are modified.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'openwrt/files/usr/lib/freeisp'))
from hotspot_runtime import Runtime, command, ident


def configuration():
    return {'schema': 1, 'revision': 1, 'collections': {
        'servers': [{'id': 'server', 'name': 'test', 'interface': 'hs-router', 'address_pool': '10.42.0.0/24', 'profile': 'portal'}],
        'server_profiles': [{'id': 'portal', 'name': 'portal', 'hotspot_address': '10.42.0.1', 'http_port': 6480}],
        'users': [{'id': 'user', 'name': 'alice', 'profile': 'profile'}],
        'user_profiles': [{'id': 'profile', 'rate_limit_up': 0, 'rate_limit_down': 0}],
        'ip_bindings': [], 'service_ports': [], 'walled_garden': [], 'walled_garden_ip': []}}


class FirewallRendering(unittest.TestCase):
    def test_no_shell_or_nft_injection(self):
        config = configuration()
        config['collections']['servers'][0]['interface'] = 'br-x";flush ruleset'
        with self.assertRaises(Exception):
            Runtime(guard_path=None).render(config, [])

    def test_no_wildcard_or_ipv6_garden(self):
        runtime = Runtime(guard_path=None)
        config = configuration()
        config['collections']['walled_garden'] = [{'id': 'garden', 'host': '*.example.test', 'action': 'allow'}]
        with self.assertRaises(Exception):
            runtime.render(config, [])
        config['collections']['walled_garden'] = []
        config['collections']['walled_garden_ip'] = [{'id': 'ip', 'dst_address': '2001:db8::/32'}]
        with self.assertRaises(Exception):
            runtime.render(config, [])

    def test_guard_defaults_to_drop_without_daemon_mark(self):
        guard = Runtime(guard_path=None)._guard(configuration())
        self.assertIn('iifname "hs-router" meta mark & 0x04000000 != 0x04000000 drop', guard)
        self.assertIn('oifname "hs-router"', guard)
        self.assertNotIn('flush ruleset', guard)

    def test_mac_only_binding_reverse_uses_observed_neighbor(self):
        runtime = Runtime(guard_path=None)
        runtime.mac_addresses = {'02:00:00:00:00:10': ['10.42.0.10']}
        self.assertEqual(runtime._binding_match({'mac_address': '02:00:00:00:00:10'}, False), 'ip daddr { 10.42.0.10 }')

    def test_unresolved_domain_rule_is_rejected(self):
        runtime = Runtime(guard_path=None, resolver=lambda *_: [])
        config = configuration()
        config['collections']['walled_garden'] = [{'id': 'garden', 'host': 'missing.test', 'action': 'allow'}]
        with self.assertRaisesRegex(Exception, 'Cannot resolve'):
            runtime.render(config, [])

    def test_portal_dns_alias_must_resolve_to_existing_gateway(self):
        runtime = Runtime(guard_path=None, verify_firewall=False,
                          resolver=lambda *_: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.42.0.1', 0))])
        runtime.interfaces = lambda: [{'name': 'hs-router', 'eligible': True, 'addresses': ['10.42.0.1'], 'networks': ['10.42.0.0/24']}]
        config = configuration()
        config['collections']['server_profiles'][0]['dns_name'] = 'login.example.test'
        runtime.validate(config)
        runtime.dns_cache.clear()
        runtime.resolver = lambda *_: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('203.0.113.1', 0))]
        with self.assertRaisesRegex(Exception, 'DNS name'):
            runtime.validate(config)

    def test_overlapping_servers_are_rejected_before_ambiguous_client_authentication(self):
        runtime = Runtime(guard_path=None, verify_firewall=False)
        runtime.interfaces = lambda: [{'name': name, 'eligible': True, 'addresses': [address], 'networks': ['10.42.0.0/24']}
                                      for name, address in [('hs-router', '10.42.0.1'), ('hs-other', '10.42.0.2')]]
        config = configuration()
        config['collections']['servers'].append({'id': 'other', 'interface': 'hs-other', 'address_pool': '10.42.0.0/24', 'profile': 'portal2'})
        config['collections']['server_profiles'].append({'id': 'portal2', 'hotspot_address': '10.42.0.2', 'http_port': 6480})
        with self.assertRaisesRegex(Exception, 'non-overlapping'):
            runtime.validate(config)


def private_network_namespace():
    try:
        return (sys.platform.startswith('linux') and os.environ.get('FREEISP_NETNS') == '1'
                and os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'))
    except OSError:
        return False


@unittest.skipUnless(private_network_namespace(),
                     'Kernel packet tests require disposable root network namespace')
class KernelPackets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Three nested namespaces are anonymous and referenced by process id;
        # unlike ip netns names, they do not alter host /run/netns mount points.
        cls.children = []
        for _ in range(2):
            child = subprocess.Popen(['unshare', '-n', 'sleep', '300'])
            cls.children.append(child)
        time.sleep(0.1)
        cls.client_pid, cls.destination_pid = [x.pid for x in cls.children]
        def ip(*args):
            command(['ip', *args])
        ip('link', 'set', 'lo', 'up')
        ip('link', 'add', 'hs-router', 'type', 'veth', 'peer', 'name', 'hs-client')
        ip('link', 'add', 'hs-uplink', 'type', 'veth', 'peer', 'name', 'hs-dest')
        ip('link', 'set', 'hs-client', 'netns', str(cls.client_pid))
        ip('link', 'set', 'hs-dest', 'netns', str(cls.destination_pid))
        ip('address', 'add', '10.42.0.1/24', 'dev', 'hs-router')
        ip('address', 'add', '198.18.0.1/24', 'dev', 'hs-uplink')
        ip('-6', 'address', 'add', '2001:db8:42::1/64', 'dev', 'hs-router')
        ip('-6', 'address', 'add', '2001:db8:18::1/64', 'dev', 'hs-uplink')
        ip('link', 'set', 'hs-router', 'up')
        ip('link', 'set', 'hs-uplink', 'up')
        command(['sysctl', '-qw', 'net.ipv4.ip_forward=1'])
        command(['sysctl', '-qw', 'net.ipv6.conf.all.forwarding=1'])
        cls.in_ns(cls.client_pid, ['ip', 'link', 'set', 'lo', 'up'])
        cls.in_ns(cls.client_pid, ['ip', 'link', 'set', 'hs-client', 'address', '02:00:00:00:00:10'])
        cls.in_ns(cls.client_pid, ['ip', 'address', 'add', '10.42.0.10/24', 'dev', 'hs-client'])
        cls.in_ns(cls.client_pid, ['ip', '-6', 'address', 'add', '2001:db8:42::10/64', 'dev', 'hs-client'])
        cls.in_ns(cls.client_pid, ['ip', 'link', 'set', 'hs-client', 'up'])
        cls.in_ns(cls.client_pid, ['ip', 'route', 'add', 'default', 'via', '10.42.0.1'])
        cls.in_ns(cls.client_pid, ['ip', '-6', 'route', 'add', 'default', 'via', '2001:db8:42::1'])
        cls.in_ns(cls.destination_pid, ['ip', 'link', 'set', 'lo', 'up'])
        cls.in_ns(cls.destination_pid, ['ip', 'address', 'add', '198.18.0.2/24', 'dev', 'hs-dest'])
        cls.in_ns(cls.destination_pid, ['ip', '-6', 'address', 'add', '2001:db8:18::2/64', 'dev', 'hs-dest'])
        cls.in_ns(cls.destination_pid, ['ip', 'link', 'set', 'hs-dest', 'up'])
        cls.in_ns(cls.destination_pid, ['ip', 'route', 'add', 'default', 'via', '198.18.0.1'])
        cls.in_ns(cls.destination_pid, ['ip', '-6', 'route', 'add', 'default', 'via', '2001:db8:18::1'])
        command(['nft', '-f', '-'], 'table inet fw4 {\n chain input { type filter hook input priority 0; policy accept; }\n chain forward { type filter hook forward priority 0; policy accept; }\n}\n')
        cls.http = subprocess.Popen(['nsenter', '-t', str(cls.destination_pid), '-n', sys.executable, '-m', 'http.server', '8080', '--bind', '198.18.0.2'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.local_http = subprocess.Popen([sys.executable, '-m', 'http.server', '6480', '--bind', '10.42.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.admin_http = subprocess.Popen([sys.executable, '-m', 'http.server', '8888', '--bind', '10.42.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        for process in [cls.http, cls.local_http, cls.admin_http] + cls.children:
            process.terminate()
        for process in [cls.http, cls.local_http, cls.admin_http] + cls.children:
            process.wait(timeout=3)

    @classmethod
    def in_ns(cls, pid, argv):
        return command(['nsenter', '-t', str(pid), '-n', *argv])

    def setUp(self):
        self.config = configuration()
        self.runtime = Runtime(guard_path=None, verify_firewall=False,
                               resolver=lambda *_args: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.18.0.2', 0))])
        self.session = {'id': 'session', 'user_id': 'user', 'user': 'alice', 'server': 'server',
                        'address': '10.42.0.10', 'mac_address': '02:00:00:00:00:10', 'profile': 'profile', 'started_at': time.time()}
        self.runtime.configure(self.config, [])

    def request(self, address='198.18.0.2', port=8080, mac=None, source='10.42.0.10'):
        if mac:
            self.in_ns(self.client_pid, ['ip', 'link', 'set', 'hs-client', 'address', mac])
        script = 'import socket,sys;s=socket.socket();s.settimeout(.7);s.bind((sys.argv[3],0));s.connect((sys.argv[1],int(sys.argv[2])));s.sendall(b"GET / HTTP/1.0\\r\\n\\r\\n");assert s.recv(100).startswith(b"HTTP/")'
        result = subprocess.run(['nsenter', '-t', str(self.client_pid), '-n', sys.executable, '-c', script, address, str(port), source], capture_output=True)
        if mac:
            self.in_ns(self.client_pid, ['ip', 'link', 'set', 'hs-client', 'address', '02:00:00:00:00:10'])
        return result.returncode == 0

    def test_unauthenticated_dropped_http_redirected_and_admin_protected(self):
        self.assertFalse(self.request())
        self.assertTrue(self.request(port=80))
        self.assertFalse(self.request('10.42.0.1', 8888))
        self.assertTrue(self.request('10.42.0.1', 6480))

    def test_login_grants_access_logout_revokes_and_counts_bytes(self):
        self.runtime.configure(self.config, [self.session])
        self.assertTrue(self.request())
        counters = self.runtime.observe(self.config)['counters']['session']
        self.assertGreater(counters['bytes_in'], 0)
        self.assertGreater(counters['bytes_out'], 0)
        self.runtime.configure(self.config, [])
        self.assertFalse(self.request())

    def test_same_ip_wrong_mac_is_denied(self):
        self.runtime.configure(self.config, [self.session])
        self.assertFalse(self.request(mac='02:00:00:00:00:99'))

    def test_expired_lease_revokes_without_daemon(self):
        self.runtime.configure(self.config, [self.session])
        key = ident('session')
        command(['nft', '-f', '-'], 'flush set inet freeisp_hotspot lease_' + key + '\nadd element inet freeisp_hotspot lease_' + key + ' { 10.42.0.10 timeout 1s }\n')
        self.assertTrue(self.request())
        time.sleep(1.2)
        self.assertFalse(self.request())

    def test_disabled_hotspot_restores_existing_firewall(self):
        self.config['collections']['servers'][0]['disabled'] = True
        self.runtime.configure(self.config, [])
        self.assertTrue(self.request())
        self.assertTrue(self.request('10.42.0.1', 8888))

    def test_disabled_server_profile_stops_then_restores_its_server(self):
        self.config['collections']['server_profiles'][0]['disabled'] = True
        self.runtime.configure(self.config, [])
        self.assertTrue(self.request())
        self.config['collections']['server_profiles'][0]['disabled'] = False
        self.runtime.configure(self.config, [])
        self.assertFalse(self.request())

    def test_blocked_overrides_bypass_and_authenticated_session(self):
        self.config['collections']['ip_bindings'] = [{'id': 'bypass', 'address': '10.42.0.0/24', 'type': 'bypassed'},
                                                     {'id': 'block', 'address': '10.42.0.10', 'type': 'blocked'}]
        self.runtime.configure(self.config, [self.session])
        self.assertFalse(self.request())

    def test_mac_restricted_subnet_block_does_not_drop_other_clients(self):
        self.in_ns(self.client_pid, ['ip', 'address', 'add', '10.42.0.11/24', 'dev', 'hs-client'])
        command(['ip', 'neigh', 'replace', '10.42.0.10', 'lladdr', '02:00:00:00:00:10', 'dev', 'hs-router', 'nud', 'permanent'])
        command(['ip', 'neigh', 'replace', '10.42.0.11', 'lladdr', '02:00:00:00:00:11', 'dev', 'hs-router', 'nud', 'permanent'])
        try:
            self.config['collections']['ip_bindings'] = [{'id': 'bypass', 'address': '10.42.0.0/24', 'type': 'bypassed'},
                {'id': 'block', 'address': '10.42.0.0/24', 'mac_address': '02:00:00:00:00:10', 'type': 'blocked'}]
            self.runtime.configure(self.config, [])
            self.assertTrue(self.request(mac='02:00:00:00:00:11', source='10.42.0.11'))
            self.assertFalse(self.request())
        finally:
            self.in_ns(self.client_pid, ['ip', 'address', 'del', '10.42.0.11/24', 'dev', 'hs-client'])
            command(['ip', 'neigh', 'del', '10.42.0.11', 'dev', 'hs-router'], allow_fail=True)

    def test_ip_and_mac_only_bypass_are_bidirectional(self):
        for binding in ({'address': '10.42.0.10'}, {'mac_address': '02:00:00:00:00:10'}):
            # A probe populates the actual neighbor table before MAC-only resolution.
            self.request('10.42.0.1', 6480)
            self.config['collections']['ip_bindings'] = [dict(binding, id='bypass', type='bypassed')]
            self.runtime.configure(self.config, [])
            self.assertTrue(self.request(), str(binding))

    def test_regular_binding_overrides_subnet_bypass(self):
        self.config['collections']['ip_bindings'] = [{'id': 'bypass', 'address': '10.42.0.0/24', 'type': 'bypassed'},
                                                     {'id': 'regular', 'address': '10.42.0.10', 'type': 'regular'}]
        self.runtime.configure(self.config, [])
        self.assertFalse(self.request())
        self.assertTrue(self.request(port=80))

    def test_ip_and_dns_walled_gardens_and_deny_priority(self):
        for collection, row in (('walled_garden_ip', {'id': 'garden', 'dst_address': '198.18.0.2', 'protocol': 'tcp', 'dst_port': '8080', 'action': 'allow'}),
                                ('walled_garden', {'id': 'garden', 'host': 'example.test', 'port': 8080, 'action': 'allow'})):
            self.config = configuration()
            self.config['collections'][collection] = [row]
            self.runtime.configure(self.config, [])
            self.assertTrue(self.request(), collection)
            self.config['collections']['walled_garden_ip'].append({'id': 'deny', 'dst_address': '198.18.0.2', 'protocol': 'tcp', 'dst_port': '8080', 'action': 'deny'})
            self.runtime.configure(self.config, [])
            self.assertFalse(self.request(), collection)

    def test_service_ports_require_authentication(self):
        self.config['collections']['service_ports'] = [{'id': 'admin', 'protocol': 'tcp', 'ports': '8888'}]
        self.runtime.configure(self.config, [])
        self.assertFalse(self.request('10.42.0.1', 8888))
        self.runtime.configure(self.config, [self.session])
        self.assertTrue(self.request('10.42.0.1', 8888))

    def test_counters_survive_reconfigure_and_rate_rules_accepted(self):
        self.config['collections']['user_profiles'][0]['rate_limit_up'] = 500000
        self.config['collections']['user_profiles'][0]['rate_limit_down'] = 500000
        self.runtime.configure(self.config, [self.session])
        self.assertTrue(self.request())
        before = self.runtime.observe(self.config)['counters']['session']['bytes_in']
        self.config['revision'] += 1
        self.runtime.configure(self.config, [self.session])
        after = self.runtime.observe(self.config)['counters']['session']['bytes_in']
        self.assertGreaterEqual(after, before)
        self.session['accounted_at'] = time.time()
        signature = self.runtime.signature
        self.runtime.configure(self.config, [self.session])
        self.assertEqual(self.runtime.signature, signature)

    def test_guard_fail_closed_when_daemon_table_disappears(self):
        self.runtime.configure(self.config, [self.session])
        command(['nft', 'delete', 'table', 'inet', 'freeisp_hotspot'])
        self.assertFalse(self.request())
        observation = self.runtime.observe(self.config)
        self.assertFalse(observation['available'])
        self.assertIn('missing', observation['error'])
        self.assertFalse(any(host['authorized'] for host in observation['hosts']))

    def test_ipv6_does_not_bypass_authorization(self):
        self.runtime.configure(self.config, [self.session])
        result = subprocess.run(['nsenter', '-t', str(self.client_pid), '-n', 'ping', '-6', '-c', '1', '-W', '1', '2001:db8:18::2'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_real_captive_login_cookie_and_logout_control_internet_packets(self):
        from hotspot import Engine
        from hotspot_service import Controller
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(guard_path=None, verify_firewall=False)
            engine = Engine(os.path.join(directory, 'config.json'), os.path.join(directory, 'state.json'), runtime)
            controller = Controller(engine, runtime)
            try:
                setup = engine.dispatch('setup', {'revision': 0, 'name': 'Guest', 'interface': 'hs-router',
                                                  'local_address': '10.42.0.1', 'address_pool': '10.42.0.0/24', 'http_port': 6481})
                profile = engine.snapshot()['collections']['user_profiles'][0]['id']
                engine.dispatch('save', {'revision': engine.config['revision'], 'collection': 'users',
                                         'record': {'name': 'alice', 'password': 'real-client-password', 'profile': profile}})
                self.assertFalse(self.request())
                script = '''import http.client,json,re,sys,urllib.parse
c=http.client.HTTPConnection('10.42.0.1',6481,timeout=3)
c.request('GET','/',headers={'Cookie':sys.argv[2]})
r=c.getresponse();body=r.read().decode();token=re.search('name="csrf" value="([^"]+)"',body)[1]
if sys.argv[1]=='cookie':
 print(json.dumps({'connected':'You are connected' in body}));sys.exit()
values={'csrf':token,'username':'alice','password':sys.argv[3],'remember':'1'}
c.request('POST','/logout' if sys.argv[1]=='logout' else '/login',body=urllib.parse.urlencode(values),headers={'Content-Type':'application/x-www-form-urlencoded'})
r=c.getresponse();r.read();print(json.dumps({'status':r.status,'cookie':r.getheader('Set-Cookie','').split(';',1)[0]}))
'''
                def portal(action, cookie='', password='real-client-password'):
                    response = self.in_ns(self.client_pid, [sys.executable, '-c', script, action, cookie, password])
                    return json.loads(response.stdout)
                self.assertEqual(portal('login', password='wrong')['status'], 400)
                self.assertFalse(self.request())
                login = portal('login')
                self.assertEqual(login['status'], 303)
                self.assertTrue(self.request())
                engine.dispatch('disconnect', {'ids': [engine.state['sessions'][0]['id']]})
                self.assertFalse(self.request())
                self.assertTrue(portal('cookie', login['cookie'])['connected'])
                self.assertTrue(self.request())
                self.assertEqual(portal('logout', login['cookie'])['status'], 303)
                self.assertFalse(self.request())
                self.assertFalse(engine.state['cookies'])
                self.assertFalse(portal('cookie', login['cookie'])['connected'])
            finally:
                if controller.portal:
                    controller.portal.shutdown()
                    controller.portal.server_close()


if __name__ == '__main__':
    if sys.platform.startswith('linux') and os.environ.get('FREEISP_NETNS') != '1' and os.geteuid() == 0 and shutil.which('unshare') and shutil.which('nft'):
        env = dict(os.environ, FREEISP_NETNS='1')
        os.execvpe('unshare', ['unshare', '-n', sys.executable, __file__, *sys.argv[1:]], env)
    unittest.main(verbosity=2)
