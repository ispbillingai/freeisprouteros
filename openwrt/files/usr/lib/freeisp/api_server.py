"""FreeISP RouterOS-wire API subset backed by authenticated OpenWrt RPC.

Protocol reference: https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API
Only the explicit command table below is implemented. This is not RouterOS.
"""

import argparse
from collections import deque
import json
import re
import socket
import socketserver
import subprocess
import threading
import time

from api_protocol import ProtocolError, SentenceDecoder, encode_sentence


class ApiError(Exception):
    pass


def text(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value)


def values(value):
    return value if isinstance(value, list) else [] if value is None else [value]


class OpenWrtBackend:
    """Keep passwords/tokens out of argv, environment, files and logs."""

    def __init__(self, helper='/usr/lib/freeisp/api_ubus.uc'):
        self.helper = helper

    def request(self, action, **params):
        try:
            result = subprocess.run(['/usr/bin/ucode', self.helper],
                                    input=json.dumps(dict(action=action, **params)).encode(),
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=20, check=False)
            if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
                raise ApiError('Router service request failed')
            reply = json.loads(result.stdout)
            if not isinstance(reply, dict) or not reply.get('ok'):
                if isinstance(reply, dict) and reply.get('code') == 'hostname-saved-reload-failed':
                    raise ApiError('Hostname saved but system reload failed')
                raise ApiError('Router authentication or service request failed')
            return reply['result']
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
            raise ApiError('Router services unavailable') from error

    def login(self, username, password):
        return self.request('login', username=username, password=password)['session']

    def logout(self, session):
        self.request('destroy', session=session)

    def call(self, session, obj, method, **params):
        return self.request('call', session=session, object=obj, method=method, params=params)

    def config(self, session, name):
        return self.call(session, 'uci', 'get', config=name).get('values', {})

    def identity_set(self, session, name):
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', name):
            raise ApiError('Name must be a hostname of 1 to 63 letters, digits or hyphens')
        self.request('identity-set', session=session, name=name)

    def identity(self, session):
        board = self.call(session, 'system', 'board')
        return [{'name': board['hostname']}]

    def resource(self, session):
        info = self.call(session, 'system', 'info')
        board = self.call(session, 'system', 'board')
        memory = info.get('memory', {})
        seconds = int(info.get('uptime', 0))
        row = {'uptime': '{}d{:02d}:{:02d}:{:02d}'.format(seconds // 86400, seconds // 3600 % 24,
                                                        seconds // 60 % 60, seconds % 60),
               'version': board.get('release', {}).get('version', 'OpenWrt'),
               'platform': 'FreeISP OpenWrt', 'board-name': board.get('model', ''),
               'architecture-name': board.get('release', {}).get('target', ''),
               'free-memory': memory.get('free', 0), 'total-memory': memory.get('total', 0)}
        return [row]

    def interfaces(self, session, kind=None):
        devices = self.call(session, 'network.device', 'status')
        configs = self.config(session, 'network')
        configured = {s.get('name'): s for s in configs.values() if s.get('.type') == 'device'}
        rows = []
        for name, device in sorted(devices.items()):
            if not isinstance(device, dict):
                continue
            cfg = configured.get(name, {})
            device_type = cfg.get('type', device.get('type', ''))
            if device_type == 'bridge' or 'bridge-members' in device:
                item_kind = 'bridge'
            elif device_type in ('8021q', '8021ad'):
                item_kind = 'vlan'
            elif name == 'lo':
                item_kind = 'loopback'
            elif device.get('wireless'):
                item_kind = 'wlan'
            elif device.get('macaddr') and device_type in ('', 'Network device', 'ethernet', 1):
                item_kind = 'ether'
            else:
                item_kind = device_type or 'other'
            if kind and kind != item_kind:
                continue
            row = {'.id': '*' + name.encode().hex(), 'name': name, 'type': item_kind,
                   'running': bool(device.get('up') and device.get('carrier', True)),
                   'disabled': cfg.get('disabled') == '1'}
            for source, dest in [('mtu', 'mtu'), ('macaddr', 'mac-address')]:
                if source in device:
                    row[dest] = device[source]
            if item_kind == 'vlan':
                row.update({'vlan-id': cfg.get('vid', ''), 'interface': cfg.get('ifname', '')})
            stats = device.get('statistics', {})
            for key in ('rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets'):
                if key in stats:
                    row[key.replace('_', '-')] = stats[key]
            rows.append(row)
        return rows

    def network(self, session):
        return self.call(session, 'network.interface', 'dump').get('interface', [])

    def addresses(self, session):
        rows = []
        for interface in self.network(session):
            for address in interface.get('ipv4-address', []):
                ip, mask = address['address'], int(address['mask'])
                packed = int.from_bytes(socket.inet_aton(ip), 'big')
                network = socket.inet_ntoa((packed & ((0xffffffff << (32 - mask)) & 0xffffffff)).to_bytes(4, 'big'))
                name = interface.get('l3_device', interface.get('interface', ''))
                rows.append({'.id': '*' + (name + '/' + ip).encode().hex(), 'address': f'{ip}/{mask}',
                             'network': network, 'interface': name, 'actual-interface': name,
                             'disabled': False, 'invalid': not interface.get('up', False)})
        return rows

    def routes(self, session):
        rows = []
        for interface in self.network(session):
            for route in interface.get('route', []):
                if ':' in route.get('target', ''):
                    continue
                dest = '{}/{}'.format(route.get('target', '0.0.0.0'), route.get('mask', 0))
                gateway = route.get('nexthop') or interface.get('l3_device', '')
                rows.append({'.id': '*' + (dest + gateway + str(route.get('metric', ''))).encode().hex(),
                             'dst-address': dest, 'gateway': gateway,
                             'active': bool(interface.get('up')), 'disabled': False,
                             'routing-table': route.get('table', 'main')})
        return rows

    def dns(self, session):
        configured = []
        for section in self.config(session, 'network').values():
            if section.get('.type') == 'interface':
                configured.extend(values(section.get('dns')))
        runtime = [server for interface in self.network(session) for server in interface.get('dns-server', [])]
        return [{'servers': ','.join(dict.fromkeys(configured)),
                 'dynamic-servers': ','.join(server for server in dict.fromkeys(runtime) if server not in configured)}]

    def services(self, session):
        runtime = self.call(session, 'service', 'list')
        rows = []
        for service, config, section_type, default_port in (
                ('api', 'freeisp_api', 'service', '8728'), ('ftp', 'freeisp_ftp', 'service', '21'),
                ('ssh', 'dropbear', 'dropbear', '22'), ('www', 'uhttpd', 'uhttpd', '80')):
            sections = self.config(session, config)
            daemon = {'api': 'freeisp-api', 'ftp': 'freeisp-ftp', 'ssh': 'dropbear', 'www': 'uhttpd'}[service]
            active = any(instance.get('running') for instance in runtime.get(daemon, {}).get('instances', {}).values())
            for key, section in sections.items():
                if section.get('.type') != section_type:
                    continue
                listeners = []
                if service == 'www':
                    for field in ('listen_http', 'listen_https'):
                        for listener in values(section.get(field)):
                            host, _, port = listener.rpartition(':')
                            listeners.append((port, host, 'https' if field == 'listen_https' else 'http'))
                else:
                    listeners = [(section.get('Port' if service == 'ssh' else 'port', default_port),
                                  section.get('Interface' if service == 'ssh' else 'listen_address', '0.0.0.0'), '')]
                disabled = section.get('enable' if service == 'ssh' else 'enabled', '1') in ('0', 'false', 'no', 'off')
                for index, (port, address, protocol) in enumerate(listeners):
                    row = {'.id': '*' + (service + key + str(index)).encode().hex(), 'name': service,
                           'port': port, 'address': address, 'disabled': disabled, 'running': bool(active)}
                    if protocol:
                        row['protocol'] = protocol
                    rows.append(row)
                    if service == 'www':
                        rows.append(dict(row, **{'.id': row['.id'] + '44', 'name': 'freeisp-desk'}))
        return rows

    def files(self, session):
        result = self.call(session, 'file', 'list', path='/srv/freeisp/files')
        return [{'.id': '*' + entry['name'].encode().hex(), 'name': entry['name'],
                 'type': entry.get('type', 'unknown'), 'size': entry.get('size', 0)}
                for entry in result.get('entries', []) if entry.get('name') not in ('.', '..')]

    def print_command(self, session, command):
        handlers = {'/system/resource/print': self.resource, '/system/identity/print': self.identity,
                    '/interface/print': self.interfaces, '/ip/address/print': self.addresses,
                    '/ip/route/print': self.routes, '/ip/dns/print': self.dns,
                    '/ip/service/print': self.services, '/file/print': self.files}
        interface_kinds = {'/interface/ethernet/print': 'ether', '/interface/bridge/print': 'bridge',
                           '/interface/vlan/print': 'vlan'}
        if command in interface_kinds:
            return self.interfaces(session, interface_kinds[command])
        if command not in handlers:
            raise ApiError('Command is not supported by the FreeISP API subset')
        return handlers[command](session)


def parse_sentence(words):
    try:
        words = [word.decode('utf-8') for word in words]
    except UnicodeError as error:
        raise ApiError('API words must be valid UTF-8') from error
    command, attrs, queries, tag = words[0], {}, [], None
    if not command.startswith('/'):
        raise ApiError('Invalid command')
    for word in words[1:]:
        if word.startswith('.tag='):
            if tag is not None or len(word) > 133:
                raise ApiError('Invalid or duplicate tag')
            tag = word[5:]
        elif word.startswith('=') and '=' in word[1:]:
            key, value = word[1:].split('=', 1)
            if key in attrs or not key:
                raise ApiError('Invalid or duplicate attribute')
            attrs[key] = value
        elif word.startswith('?'):
            queries.append(word[1:])
        else:
            raise ApiError('Unsupported API attribute')
    return command, attrs, queries, tag


def filters(queries):
    """Explicit subset: property existence/absence and equality, combined with AND."""
    result = []
    for query in queries:
        if query.startswith('='):
            query = query[1:]
        if query.startswith('-') and '=' not in query:
            key, op, value = query[1:], 'absent', None
        elif '=' in query:
            key, value = query.split('=', 1)
            op = 'equal'
        else:
            key, op, value = query, 'exists', None
        if not re.fullmatch(r'[A-Za-z_.][A-Za-z0-9_.-]*', key):
            raise ApiError('Unsupported query; use property existence, absence or equality')
        result.append((key, op, value))
    return result


def matches(row, tests):
    return all((key not in row if op == 'absent' else key in row if op == 'exists'
                else key in row and text(row[key]) == value) for key, op, value in tests)


class LoginLimiter:
    """Global cap also bounds distributed login attempts and rpcd session creation."""
    def __init__(self):
        self.attempts = deque()
        self.lock = threading.Lock()

    def allow(self):
        now = time.monotonic()
        with self.lock:
            while self.attempts and self.attempts[0] < now - 60:
                self.attempts.popleft()
            if len(self.attempts) >= 20:
                return False
            self.attempts.append(now)
            return True


class ApiHandler(socketserver.BaseRequestHandler):
    def send(self, kind, attrs=None, tag=None):
        words = [kind.encode()] + [('=' + key + '=' + text(value)).encode() for key, value in (attrs or {}).items()]
        if tag:
            words.append(('.tag=' + tag).encode())
        self.request.sendall(encode_sentence(words))

    def command(self, words):
        tag = None
        try:
            command, attrs, queries, tag = parse_sentence(words)
            if command == '/login':
                if self.session:
                    raise ApiError('Already logged in')
                if set(attrs) != {'name', 'password'} or queries:
                    raise ApiError('Use post-v6.43 login with name and password')
                if not self.server.login_limiter.allow():
                    self.stop = True
                    raise ApiError('Too many login attempts; try later')
                if attrs['name'] != 'root' or not attrs['password'] or len(attrs['password']) > 1024:
                    raise ApiError('Invalid user name or password')
                try:
                    self.session = self.server.backend.login(attrs['name'], attrs['password'])
                except ApiError:
                    raise ApiError('Invalid user name or password') from None
            elif not self.session:
                raise ApiError('Authentication required')
            elif command == '/system/identity/set':
                if set(attrs) != {'name'} or queries:
                    raise ApiError('Identity set accepts only name')
                with self.server.write_lock:
                    self.server.backend.identity_set(self.session, attrs['name'])
            elif command.endswith('/print'):
                if set(attrs) - {'.proplist', 'detail'}:
                    raise ApiError('Unsupported print option')
                tests = filters(queries)
                properties = attrs.get('.proplist')
                properties = set(properties.split(',')) if properties else set() if properties == '' else None
                if properties is not None and any(not re.fullmatch(r'[A-Za-z_.][A-Za-z0-9_.-]*', key) for key in properties):
                    raise ApiError('Invalid property list')
                rows = self.server.backend.print_command(self.session, command)
                if len(rows) > 4096:
                    raise ApiError('Result too large; narrow the command')
                output, size = [], 0
                for row in rows:
                    if matches(row, tests):
                        item = {key: value for key, value in row.items() if properties is None or key in properties}
                        size += sum(len(key.encode()) + len(text(value).encode()) + 8 for key, value in item.items())
                        if size > 512 * 1024:
                            raise ApiError('Result too large; request fewer properties')
                        output.append(item)
                for row in output:
                    self.send('!re', row, tag)
            else:
                raise ApiError('Command is not supported by the FreeISP API subset')
            self.send('!done', tag=tag)
        except ApiError as error:
            if not self.session:
                self.failures += 1
                if self.failures >= 3:
                    self.stop = True
            self.send('!trap', {'category': '1', 'message': str(error)}, tag)
            self.send('!done', tag=tag)
        except (KeyError, TypeError, ValueError):
            self.send('!trap', {'category': '2', 'message': 'Invalid router service response'}, tag)
            self.send('!done', tag=tag)

    def handle(self):
        self.session, self.failures, self.stop = None, 0, False
        decoder = SentenceDecoder(max_word_bytes=8192, max_sentence_bytes=16384, max_words=128)
        deadline = time.monotonic() + self.server.sentence_timeout
        try:
            while not self.stop:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.request.settimeout(min(self.server.idle_timeout, remaining))
                chunk = self.request.recv(4096)
                if not chunk:
                    break
                for sentence in decoder.feed(chunk):
                    self.request.settimeout(self.server.idle_timeout)
                    self.command(sentence)
                    deadline = time.monotonic() + self.server.sentence_timeout
                    if self.stop:
                        break
        except ProtocolError:
            try:
                self.send('!fatal', {'message': 'Invalid or oversized API sentence'})
            except OSError:
                pass
        except OSError:
            pass
        finally:
            if self.session:
                try:
                    self.server.backend.logout(self.session)
                except ApiError:
                    pass


class ApiServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False
    request_queue_size = 8

    def __init__(self, address, backend=None, max_clients=8, idle_timeout=60, sentence_timeout=60):
        self.backend = backend or OpenWrtBackend()
        self.clients = threading.BoundedSemaphore(max_clients)
        self.login_limiter = LoginLimiter()
        self.write_lock = threading.Lock()
        self.idle_timeout, self.sentence_timeout = idle_timeout, sentence_timeout
        if ':' in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, ApiHandler)

    def process_request(self, request, client_address):
        if not self.clients.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.clients.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.clients.release()

    def handle_error(self, request, client_address):
        # Never log client payloads or tracebacks containing authentication data.
        pass


def main():
    parser = argparse.ArgumentParser(description='FreeISP RouterOS-wire API subset')
    parser.add_argument('--listen-address', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8728)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        socket.inet_pton(socket.AF_INET6 if ':' in args.listen_address else socket.AF_INET, args.listen_address)
    except OSError:
        parser.error('listen-address must be an IP address')
    with ApiServer((args.listen_address, args.port)) as server:
        server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    main()
