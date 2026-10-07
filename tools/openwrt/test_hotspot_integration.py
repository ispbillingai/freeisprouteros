"""Exercise the real model and enforcement adapter together at their boundary.

Network command responses are isolated fixtures here; Linux packet tests cover
the generated rules against the kernel, and the VM test covers actual rpcd.
"""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'openwrt/files/usr/lib/freeisp'))
from hotspot import Engine, HotspotError
from hotspot_runtime import Runtime


class RouterCommands:
    def __init__(self):
        self.installed = None
        self.batches = []
        self.reject_apply = False
        self.offload = False

    def __call__(self, argv, data=None, allow_fail=False):
        result, code = {}, 0
        if argv[:5] == ['ip', '-j', '-4', 'address', 'show']:
            result = [{'ifname': 'br-test', 'addr_info': [{'family': 'inet', 'local': '10.42.0.1', 'prefixlen': 24}]},
                      {'ifname': 'eth0', 'addr_info': [{'family': 'inet', 'local': '10.0.2.15', 'prefixlen': 24}]},
                      {'ifname': 'eth2', 'addr_info': [{'family': 'inet', 'local': '10.78.0.15', 'prefixlen': 24}]}]
        elif argv[:5] == ['ip', '-j', '-4', 'route', 'show']:
            result = [{'dev': 'eth0'}]
        elif argv[:5] == ['ip', '-j', '-4', 'neigh', 'show']:
            result = [{'dev': 'br-test', 'dst': '10.42.0.10', 'lladdr': '02:00:00:00:00:10', 'state': ['REACHABLE']}]
        elif argv[:4] == ['ubus', 'call', 'network.interface', 'dump']:
            result = {'interface': [{'interface': 'lan', 'device': 'br-test', 'l3_device': 'br-test'},
                                    {'interface': 'wan', 'device': 'eth0', 'l3_device': 'eth0'},
                                    {'interface': 'management', 'device': 'eth2', 'l3_device': 'eth2'}]}
        elif argv[:4] == ['ubus', 'call', 'uci', 'get']:
            result = {'values': {'defaults': {'.type': 'defaults', 'flow_offloading': str(int(self.offload))},
                                'lan': {'.type': 'zone', 'name': 'lan', 'network': ['lan'], 'input': 'ACCEPT', 'forward': 'ACCEPT'},
                                'wan': {'.type': 'zone', 'name': 'wan', 'network': ['wan'], 'input': 'REJECT'},
                                'forward': {'.type': 'forwarding', 'src': 'lan', 'dest': 'wan'}}}
        elif argv == ['nft', '-j', 'list', 'ruleset']:
            result = {'nftables': []}
        elif argv == ['nft', '-j', 'list', 'table', 'inet', 'freeisp_hotspot']:
            if self.installed is None:
                code = 1
            else:
                result = {'nftables': [{'table': {'family': 'inet', 'name': 'freeisp_hotspot'}}]}
                for name in re.findall(r' counter (\w+) \{', self.installed):
                    result['nftables'].append({'counter': {'name': name, 'bytes': 0, 'packets': 0}})
        elif argv == ['nft', '-j', 'list', 'table', 'inet', 'fw4']:
            code = 1
        elif argv == ['nft', '-c', '-f', '-']:
            pass
        elif argv == ['nft', '-f', '-']:
            if self.reject_apply:
                raise RuntimeError('Injected firewall apply failure')
            self.batches.append(data)
            if 'table inet freeisp_hotspot {' in data:
                self.installed = data
        else:
            raise AssertionError('Unexpected command: ' + repr(argv))
        return subprocess.CompletedProcess(argv, code, json.dumps(result), '')


class ModelRuntimeIntegration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.router = RouterCommands()
        self.runtime = Runtime(runner=self.router, guard_path=str(self.root / 'guard.nft'))
        self.engine = Engine(str(self.root / 'config.json'), str(self.root / 'state.json'), runtime=self.runtime)

    def tearDown(self):
        self.directory.cleanup()

    def action(self, action, **payload):
        payload['revision'] = self.engine.snapshot()['revision']
        return self.engine.dispatch(action, payload)

    def setup(self):
        self.action('setup', name='test', interface='br-test', local_address='10.42.0.1', address_pool='10.42.0.0/24')
        snapshot = self.engine.snapshot()
        self.server = snapshot['collections']['servers'][0]['id']
        self.profile = snapshot['collections']['user_profiles'][0]['id']

    def test_setup_compiles_real_enforcement_and_protects_management(self):
        self.setup()
        rules = self.router.installed
        self.assertIn('iifname "br-test"', rules)
        self.assertIn('meta nfproto ipv6 drop', rules)
        self.assertIn('redirect to :6480', rules)
        self.assertNotIn('iifname "eth2"', rules)
        self.assertIn('br-test', (self.root / 'guard.nft').read_text())
        self.assertEqual(len(self.engine.snapshot()['collections']['servers']), 1)

    def test_login_and_account_disable_change_actual_runtime_authorizations(self):
        self.setup()
        user = self.action('save', collection='users', record={'name': 'alice', 'password': 'private-test-password', 'profile': self.profile})['id']
        result = self.engine.login('alice', 'private-test-password', '10.42.0.10', '02:00:00:00:00:10', self.server, remember=True)
        self.assertTrue(result['ok'])
        self.assertIn('ether saddr 02:00:00:00:00:10', self.router.installed)
        self.assertIn('timeout 30s', self.router.installed)
        public = json.dumps(self.engine.snapshot())
        self.assertNotIn('private-test-password', public)
        self.assertNotIn('pbkdf2', public)
        self.assertNotIn(result['cookie'], public)
        self.action('set_enabled', collection='users', ids=[user], enabled=False)
        self.assertNotIn('set lease_', self.router.installed)
        self.assertFalse(self.engine.snapshot()['collections']['active'])
        self.assertFalse(self.engine.snapshot()['collections']['cookies'])

    def test_bad_password_never_grants_a_kernel_lease(self):
        self.setup()
        self.action('save', collection='users', record={'name': 'alice', 'password': 'private-test-password', 'profile': self.profile})
        with self.assertRaises(HotspotError):
            self.engine.login('alice', 'wrong', '10.42.0.10', '02:00:00:00:00:10', self.server)
        self.assertNotIn('set lease_', self.router.installed)

    def test_wan_and_maintenance_setup_rejected_without_partial_profiles(self):
        for iface, address, pool in [('eth0', '10.0.2.15', '10.0.2.0/24'), ('eth2', '10.78.0.15', '10.78.0.0/24')]:
            with self.subTest(iface=iface), self.assertRaises(HotspotError):
                self.action('setup', name='bad', interface=iface, local_address=address, address_pool=pool)
            snapshot = self.engine.snapshot()
            self.assertFalse(snapshot['collections']['servers'])
            self.assertFalse(snapshot['collections']['server_profiles'])

    def test_failed_firewall_apply_does_not_commit_configuration(self):
        self.setup()
        original = copy.deepcopy(self.engine.snapshot())
        self.router.reject_apply = True
        with self.assertRaises(HotspotError):
            self.action('save', collection='ip_bindings', record={'address': '10.42.0.10', 'type': 'blocked'})
        self.router.reject_apply = False
        snapshot = self.engine.snapshot()
        self.assertEqual(snapshot['revision'], original['revision'])
        self.assertFalse(snapshot['collections']['ip_bindings'])

    def test_offloading_cannot_silently_bypass_hotspot(self):
        self.router.offload = True
        with self.assertRaisesRegex(HotspotError, 'offloading'):
            self.setup()


if __name__ == '__main__':
    unittest.main()
