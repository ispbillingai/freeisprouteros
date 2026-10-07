"""Backend regression tests; VM packet tests are in test-pppoe-vm.py."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pppoe', ROOT / 'openwrt/files/usr/lib/freeisp/pppoe.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def fixture():
    return {
        'pools': [{'id': '111111111111', 'name': 'customers', 'start': '10.80.0.10', 'end': '10.80.0.20'}],
        'profiles': [{'id': '222222222222', 'name': 'basic', 'local_ip': '10.80.0.1', 'pool': '111111111111', 'dns1': '1.1.1.1', 'dns2': '', 'download': 2048, 'upload': 1024}],
        'servers': [{'id': '333333333333', 'name': 'internet', 'interface': 'br-lan', 'profile': '222222222222', 'enabled': True, 'mtu': 1492, 'max_sessions': 64}],
        'secrets': [{'id': '444444444444', 'name': 'customer', 'server': '333333333333', 'profile': '', 'password': 'local-test-only', 'remote_ip': '', 'enabled': True}]
    }


class PPPoETest(unittest.TestCase):
    def test_create_edit_delete_and_stable_pool_allocation(self):
        config = p.validate(fixture())
        self.assertEqual(config['secrets'][0]['assigned_ip'], '10.80.0.10')
        candidate = p.public_config(config)
        candidate['secrets'].insert(0, dict(candidate['secrets'][0], id='555555555555', name='second', password='different'))
        result = p.validate(candidate, config)
        self.assertEqual(result['secrets'][1]['assigned_ip'], '10.80.0.10')
        self.assertEqual(result['secrets'][0]['assigned_ip'], '10.80.0.11')
        result['secrets'].pop(0)
        self.assertEqual(len(p.validate(result, config)['secrets']), 1)

    def test_private_password_roundtrip(self):
        config = p.validate(fixture())
        public = p.public_config(config)
        self.assertNotIn('password', public['secrets'][0])
        public['secrets'][0]['password'] = ''
        self.assertEqual(p.validate(public, config)['secrets'][0]['password'], 'local-test-only')

    def test_disabled_account_retains_reservation_but_cannot_authenticate(self):
        config = fixture()
        config['secrets'][0]['enabled'] = False
        config = p.validate(config)
        self.assertEqual(config['secrets'][0]['assigned_ip'], '10.80.0.10')
        with tempfile.TemporaryDirectory() as tmp:
            p.compile_config(config, Path(tmp))
            self.assertNotIn('customer', (Path(tmp) / '333333333333.secrets').read_text())

    def test_exhausted_pool(self):
        config = fixture()
        config['pools'][0]['end'] = '10.80.0.10'
        config['secrets'].append(dict(config['secrets'][0], id='555555555555', name='second'))
        with self.assertRaisesRegex(ValueError, 'Pool is full'):
            p.validate(config)

    def test_invalid_inputs(self):
        cases = [('pools', 'start', 'invalid'), ('pools', 'end', '10.80.0.1'), ('pools', 'end', '239.1.1.1'),
                 ('profiles', 'pool', 'missing'), ('profiles', 'local_ip', '10.80.0.10'), ('profiles', 'dns1', '999.1.1.1'),
                 ('profiles', 'download', -1), ('profiles', 'upload', '1000'), ('servers', 'interface', 'eth0;reboot'),
                 ('servers', 'interface', 'lo'), ('servers', 'mtu', 1500), ('servers', 'max_sessions', 0),
                 ('secrets', 'password', ''), ('secrets', 'password', '@login'), ('secrets', 'password', 'a\nb'),
                 ('secrets', 'name', '*'), ('secrets', 'remote_ip', '10.90.0.1'), ('secrets', 'server', 'missing'),
                 ('secrets', 'enabled', 'true')]
        for kind, key, value in cases:
            with self.subTest(kind=kind, key=key, value=value):
                config = fixture()
                config[kind][0][key] = value
                with self.assertRaises(ValueError):
                    p.validate(config)

    def test_reference_deletion_rejected(self):
        for kind in ('pools', 'profiles', 'servers'):
            config = fixture()
            config[kind] = []
            with self.assertRaises(ValueError):
                p.validate(config)

    def test_overlapping_pools_and_duplicate_addresses(self):
        config = fixture()
        config['pools'].append(dict(config['pools'][0], id='555555555555', name='overlap'))
        with self.assertRaisesRegex(ValueError, 'overlap'):
            p.validate(config)
        config = fixture()
        config['secrets'][0]['remote_ip'] = '10.80.0.15'
        config['secrets'].append(dict(config['secrets'][0], id='555555555555', name='second'))
        with self.assertRaisesRegex(ValueError, 'Duplicate subscriber'):
            p.validate(config)

    def test_private_files_and_per_account_profile(self):
        config = fixture()
        config['profiles'].append(dict(config['profiles'][0], id='555555555555', name='other', local_ip='10.80.0.2', dns1='8.8.8.8'))
        config['secrets'][0]['profile'] = '555555555555'
        config['secrets'][0]['password'] = 'a "quote" \\ and # space'
        config = p.validate(config)
        with tempfile.TemporaryDirectory() as tmp:
            commands = p.compile_config(config, Path(tmp))
            self.assertEqual(commands['333333333333'][:2], ['/usr/sbin/pppoe-server', '-F'])
            text = (Path(tmp) / '333333333333.secrets').read_text()
            self.assertIn('10.80.0.2:10.80.0.10', text)
            self.assertIn('ms-dns 8.8.8.8', text)
            self.assertIn('\\"quote\\"', text)
            self.assertNotIn('password', json.dumps(commands))

    def test_saved_data_survives_fresh_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pppoe.json'
            config = p.validate(fixture())
            p.write_json(path, config)
            self.assertEqual(p.read_json(path), config)
            self.assertEqual(p.validate(p.public_config(p.read_json(path)), p.read_json(path)), config)

    def test_stale_save_and_apply_failure_restore_settings(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'CONFIG', Path(tmp) / 'pppoe.json'), patch.object(p, 'RUN', Path(tmp) / 'run'), patch.object(p, 'check_network'), patch.object(p, 'status', return_value={'available': True}):
            config = fixture()
            config['servers'][0]['enabled'] = False
            config = p.validate(config)
            p.write_json(p.CONFIG, config)
            with self.assertRaisesRegex(ValueError, 'another session'):
                p.save({'config': p.public_config(config), 'revision': 'stale'})
            changed = p.public_config(config)
            changed['profiles'][0]['name'] = 'updated'
            with patch.object(p, 'restart_and_wait', side_effect=[ValueError('start failed'), None]):
                with self.assertRaisesRegex(ValueError, 'Previous settings restored'):
                    p.save({'config': changed, 'revision': p.revision(config)})
            self.assertEqual(p.read_json(p.CONFIG), config)

    def test_disconnect_does_not_signal_stale_or_unknown_process(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'RUN', Path(tmp)), patch.object(p, 'sessions', return_value=[]), patch.object(p.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'already ended'):
                p.disconnect({'id': 'stale'})
            kill.assert_not_called()

    def test_revisions_hide_password_digests_and_detect_password_changes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(p, 'CONFIG', Path(tmp) / 'pppoe.json'):
            config = p.validate(fixture())
            first = p.revision(config)
            self.assertEqual(first, p.revision(copy.deepcopy(config)))
            config['secrets'][0]['password'] = 'changed'
            self.assertNotEqual(first, p.revision(config))
            self.assertEqual(len(p.CONFIG.with_suffix('.key').read_bytes()), 32)


if __name__ == '__main__':
    unittest.main()
