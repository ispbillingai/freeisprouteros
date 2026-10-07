"""Exercise captive forms, real account authentication, cookies, CSRF and rpcd framing."""
import copy
import html
import http.client
import io
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlencode

LIBRARY = Path(__file__).resolve().parents[2] / 'openwrt/files/usr/lib/freeisp'
sys.path.insert(0, str(LIBRARY))
from hotspot import Engine
from hotspot_runtime import Runtime
from hotspot_service import Controller, PortalHandler, PortalServer, dispatch, read_json


class FakeRuntime:
    def __init__(self, directory):
        self.sessions = []
        self.server_id = None
        self.denied = False
        self.templates = Runtime(guard_path=None, template_dir=str(directory))

    def configure(self, config, sessions):
        self.sessions = copy.deepcopy(sessions)
        servers = config['collections']['servers']
        self.server_id = servers[0]['id'] if servers else None

    def observe(self, config):
        return {'available': True, 'hosts': [], 'interfaces': [], 'counters': {}}

    def client(self, ip):
        if self.denied:
            raise ValueError('Client outside Hotspot')
        return {'ip': '10.42.0.10', 'address': '10.42.0.10', 'mac': '02:00:00:00:00:10', 'mac_address': '02:00:00:00:00:10', 'server_id': self.server_id}

    def template_path(self, server):
        return self.templates.template_path(server)

    def reset_html(self, server):
        self.templates.reset_html(server)


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        directory = Path(self.temp.name)
        self.runtime = FakeRuntime(directory)
        self.engine = Engine(str(directory / 'config.json'), str(directory / 'state.json'), self.runtime)
        self.controller = Controller(self.engine, self.runtime)
        self.server = PortalServer(('127.0.0.1', 0), PortalHandler)
        self.server.controller = self.controller
        self.server.capacity = threading.BoundedSemaphore(24)
        self.port = self.server.server_address[1]
        self.authority = '10.42.0.1:' + str(self.port)
        self.engine.dispatch('setup', {'revision': 0, 'name': 'Guest <test>', 'interface': 'br-test',
                                      'local_address': '10.42.0.1', 'address_pool': '10.42.0.0/24', 'http_port': self.port})
        snapshot = self.engine.snapshot()
        profile = snapshot['collections']['user_profiles'][0]['id']
        self.engine.dispatch('save', {'revision': snapshot['revision'], 'collection': 'users',
                                     'record': {'name': 'alice', 'password': 'a-real-test-password', 'profile': profile}})
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(2)
        self.temp.cleanup()

    def request(self, method='GET', path='/', fields=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        headers = dict(headers or {})
        headers.setdefault('Host', self.authority)
        body = None
        if fields is not None:
            body = urlencode(fields)
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read().decode()
        connection.close()
        return result

    def csrf(self):
        code, headers, body = self.request()
        self.assertEqual(code, 200)
        self.assertIn('no-store', headers['Cache-Control'])
        self.assertIn('Guest &lt;test&gt;', body)
        return re.search('name="csrf" value="([^"]+)"', body)[1]

    def login(self, **changes):
        fields = dict(csrf=self.csrf(), username='alice', password='a-real-test-password', remember='1')
        fields.update(changes)
        return self.request('POST', '/login', fields)

    def test_probe_redirects_to_canonical_router_before_login(self):
        code, headers, body = self.request(headers={'Host': 'connectivitycheck.example'})
        self.assertEqual(code, 302)
        self.assertEqual(headers['Location'], 'http://' + self.authority + '/')
        self.assertNotIn('password', body)

    def test_existing_dns_alias_is_canonical_and_gateway_still_works(self):
        profile = self.engine.config['collections']['server_profiles'][0]
        self.engine.dispatch('save', {'revision': self.engine.config['revision'], 'collection': 'server_profiles',
                                     'record': dict(profile, dns_name='login.example.test')})
        code, headers, _ = self.request(headers={'Host': 'connectivitycheck.example'})
        self.assertEqual(code, 302)
        self.assertEqual(headers['Location'], 'http://login.example.test:' + str(self.port) + '/')
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request(headers={'Host': 'login.example.test:' + str(self.port)})[0], 200)

    def test_valid_login_logout_cookie_and_reset_html(self):
        code, headers, body = self.login()
        self.assertEqual(code, 303)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Lax', headers['Set-Cookie'])
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        self.assertEqual(len(self.runtime.sessions), 1)
        self.assertIn('You are connected', self.request()[2])
        # A remembered client may authenticate again after an admin disconnect.
        sid = self.engine.state['sessions'][0]['id']
        self.engine.dispatch('disconnect', {'ids': [sid]})
        self.assertFalse(self.runtime.sessions)
        self.assertIn('You are connected', self.request(headers={'Cookie': cookie})[2])
        page = self.request()[2]
        csrf = re.search('name="csrf" value="([^"]+)"', page)[1]
        code, headers, _ = self.request('POST', '/logout', {'csrf': csrf})
        self.assertEqual(code, 303)
        self.assertIn('Max-Age=0', headers['Set-Cookie'])
        self.assertFalse(self.runtime.sessions)
        self.assertFalse(self.engine.state['cookies'])
        server = self.engine.config['collections']['servers'][0]
        path = Path(self.runtime.template_path(server))
        path.write_text('<p>Custom welcome</p>{{content}}', encoding='utf-8')
        self.assertIn('Custom welcome', self.request()[2])
        self.engine.dispatch('reset_html', {'revision': self.engine.config['revision'], 'server_id': server['id']})
        self.assertNotIn('Custom welcome', self.request()[2])

    def test_bad_password_csrf_and_cross_origin_never_authenticate(self):
        self.assertEqual(self.login(password='bad')[0], 400)
        self.assertEqual(self.login(csrf='forged')[0], 400)
        fields = dict(csrf=self.csrf(), username='alice', password='a-real-test-password')
        self.assertEqual(self.request('POST', '/login', fields, {'Origin': 'http://evil.example'})[0], 400)
        self.assertFalse(self.runtime.sessions)
        self.assertFalse(self.engine.state['cookies'])

    def test_non_customer_cannot_view_or_submit_portal(self):
        self.runtime.denied = True
        self.assertEqual(self.request()[0], 403)
        self.assertEqual(self.request('POST', '/login', {'username': 'alice', 'password': 'a-real-test-password'})[0], 400)
        self.assertFalse(self.runtime.sessions)

    def test_occupied_port_fails_before_configuration_commit(self):
        config = copy.deepcopy(self.engine.config)
        self.controller.portal_port = self.port + 1
        with self.assertRaises(OSError):
            self.controller.prepare_port(config)

    def test_unknown_management_action_rejected(self):
        with self.assertRaises(Exception):
            dispatch(self.engine, 'mutate', {'action': 'run', 'payload': '{"command":"anything"}'})
        with self.assertRaises(Exception):
            dispatch(self.engine, 'mutate', {'action': 'save', 'payload': 'not-json'})


class RPCFraming(unittest.TestCase):
    def test_open_stdin_without_newline_responds(self):
        script = 'import sys;sys.path.insert(0,sys.argv[1]);from hotspot_service import read_json;print(read_json(sys.stdin),flush=True)'
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        process = subprocess.Popen([sys.executable, '-B', '-c', script, str(LIBRARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            process.stdin.write(b'{"method":"snapshot"}')
            process.stdin.flush()
            messages = queue.Queue()
            reader = threading.Thread(target=lambda: messages.put(process.stdout.readline()), daemon=True)
            reader.start()
            self.assertIn(b'snapshot', messages.get(timeout=3))
            process.wait(timeout=3)
        finally:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=3)

    def test_truncated_oversize_and_nonobject_requests_rejected(self):
        for value in (b'{"a":', b'[]', b'{}garbage'):
            with self.assertRaises(ValueError):
                read_json(io.BytesIO(value))
        with self.assertRaises(ValueError):
            read_json(io.BytesIO(b'{"value":"' + b'x' * 100 + b'"}'), limit=30)


if __name__ == '__main__':
    unittest.main(verbosity=2)
