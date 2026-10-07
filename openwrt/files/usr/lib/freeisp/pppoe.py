"""FreeISP PPPoE management. rpcd exposes only the operations in rpc().

Uses rp-pppoe and pppd 2.5, with private secrets files and per-account options.
Pools reserve one stable IPv4 address per account, including disabled accounts.
"""
import contextlib
import copy
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

ETC = Path('/etc/freeisp')
RUN = Path('/var/run/freeisp-pppoe')
CONFIG = ETC / 'pppoe.json'
KINDS = ('pools', 'profiles', 'servers', 'secrets')
EMPTY = {k: [] for k in KINDS}
ID = re.compile(r'^[a-f0-9]{12}$')
NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.@ -]{0,63}$')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(args, timeout=15):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Do not echo command arguments: they may include private settings.
        raise ValueError(Path(args[0]).name + ' failed: ' + result.stderr.strip()[:300])
    return result.stdout


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def write_json(path, value):
    atomic(path, json.dumps(value, sort_keys=True) + '\n')


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return copy.deepcopy(default)


@contextlib.contextmanager
def lock(name='config'):
    import fcntl
    RUN.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (RUN / (name + '.lock')).open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def revision(config):
    # A public plain digest of a mostly-known configuration would allow offline
    # password guessing. Authenticate revisions with a router-private random key.
    key_path = CONFIG.with_suffix('.key')
    key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        descriptor = os.open(key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(os.urandom(32))
            stream.flush()
            os.fsync(stream.fileno())
    for _ in range(100):
        key = key_path.read_bytes()
        if len(key) == 32:
            return hmac.new(key, json.dumps(config, sort_keys=True).encode(), hashlib.sha256).hexdigest()
        time.sleep(.01)
    raise ValueError('PPPoE revision key is invalid. Restore the router configuration backup.')


def ipv4(value, label):
    try:
        ip = ipaddress.IPv4Address(value)
    except (ValueError, TypeError):
        raise ValueError(label + ': enter an IPv4 address.') from None
    require(not (ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_reserved)
            and int(ip) >= 0x01000000, label + ': use a unicast IPv4 address.')
    return int(ip)


def number(row, key, low, high, default):
    value = row.get(key, default)
    require(type(value) is int and low <= value <= high, key + ': expected ' + str(low) + '–' + str(high) + '.')
    return value


def validate(value, previous=None):
    """Validate all references and allocate without trusting frontend validation."""
    previous = previous or EMPTY
    require(isinstance(value, dict) and set(value) == set(KINDS), 'Invalid configuration format.')
    result, by_id = {}, {}
    allowed = {
        'pools': {'id', 'name', 'start', 'end'},
        'profiles': {'id', 'name', 'pool', 'local_ip', 'dns1', 'dns2', 'download', 'upload'},
        'servers': {'id', 'name', 'interface', 'profile', 'enabled', 'mtu', 'max_sessions'},
        'secrets': {'id', 'name', 'server', 'profile', 'password', 'has_password', 'remote_ip', 'enabled', 'assigned_ip'}
    }
    for kind in KINDS:
        rows = value[kind]
        require(isinstance(rows, list) and len(rows) <= (4096 if kind == 'secrets' else 128), 'Too many ' + kind + '.')
        result[kind], by_id[kind], names = [], {}, set()
        for raw in rows:
            require(isinstance(raw, dict) and set(raw) <= allowed[kind], 'Invalid ' + kind + ' fields.')
            row = copy.deepcopy(raw)
            require(isinstance(row.get('id'), str) and ID.fullmatch(row['id']), 'Invalid record ID.')
            require(row['id'] not in by_id[kind], 'Duplicate record ID.')
            require(isinstance(row.get('name'), str) and NAME.fullmatch(row['name']), 'Name: use 1–64 letters, numbers, spaces, ., _, @ or -.')
            namekey = (row.get('server'), row['name']) if kind == 'secrets' else row['name']
            require(namekey not in names, 'Duplicate name: ' + row['name'])
            names.add(namekey)
            if kind in ('secrets', 'servers'):
                require(type(row.get('enabled')) is bool, 'Enabled must be true or false.')
            result[kind].append(row)
            by_id[kind][row['id']] = row
    ranges = []
    for row in result['pools']:
        first, last = ipv4(row.get('start'), 'Pool start'), ipv4(row.get('end'), 'Pool end')
        require(first <= last and last - first < 65536, 'Pool must contain 1–65,536 addresses in ascending order.')
        # Check the entire range, including ranges that cross special-use blocks.
        for block in ('0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/3'):
            net = ipaddress.ip_network(block)
            require(last < int(net.network_address) or first > int(net.broadcast_address), 'Pool includes non-unicast addresses.')
        require(all(last < a or first > b for a, b, _ in ranges), 'Address pools must not overlap.')
        ranges.append((first, last, row['id']))
    for row in result['profiles']:
        require(row.get('pool') in by_id['pools'], 'Profile ' + row['name'] + ': select an existing pool.')
        local = ipv4(row.get('local_ip'), 'Local address')
        require(all(not a <= local <= b for a, b, _ in ranges), 'Local address must be outside all subscriber pools.')
        for key in ('dns1', 'dns2'):
            row[key] = row.get(key, '')
            if row[key]:
                ipv4(row[key], 'DNS server')
        row['download'] = number(row, 'download', 0, 10000000, 0)
        row['upload'] = number(row, 'upload', 0, 10000000, 0)
    interfaces = set()
    for row in result['servers']:
        require(row.get('profile') in by_id['profiles'], 'Server ' + row['name'] + ': select an existing default profile.')
        require(isinstance(row.get('interface'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}', row['interface']), 'Select a valid Ethernet, bridge or VLAN device.')
        require(row['interface'] != 'lo' and not row['interface'].startswith(('ppp', 'fi-')), 'A PPPoE server requires an Ethernet, bridge or VLAN device.')
        if row['enabled']:
            require(row['interface'] not in interfaces, 'Only one enabled PPPoE server is allowed per device.')
            interfaces.add(row['interface'])
        row['mtu'] = number(row, 'mtu', 576, 1492, 1492)
        row['max_sessions'] = number(row, 'max_sessions', 1, 4096, 256)
    old = {r['id']: r for r in previous['secrets']}
    locals_ = {r['local_ip'] for r in result['profiles']}
    used, pending = set(), []
    for row in result['secrets']:
        require(row.get('server') in by_id['servers'], 'Secret ' + row['name'] + ': select an existing server.')
        row['profile'] = row.get('profile', '')
        profile_id = row['profile'] or by_id['servers'][row['server']]['profile']
        require(profile_id in by_id['profiles'], 'Secret ' + row['name'] + ': select an existing profile.')
        password = row.get('password') or old.get(row['id'], {}).get('password', '')
        require(isinstance(password, str) and 1 <= len(password) <= 128 and all(32 <= ord(c) <= 126 for c in password)
                and not password.startswith('@'), 'Password: use 1–128 printable characters; it cannot begin with @.')
        row['password'] = password
        row.pop('has_password', None)
        row['remote_ip'] = row.get('remote_ip', '')
        row.pop('assigned_ip', None)
        pool = by_id['pools'][by_id['profiles'][profile_id]['pool']]
        first, last = int(ipaddress.IPv4Address(pool['start'])), int(ipaddress.IPv4Address(pool['end']))
        if row['remote_ip']:
            address = ipv4(row['remote_ip'], 'Remote address')
            require(first <= address <= last, 'Remote address must be inside the selected profile pool.')
            require(address not in used, 'Duplicate subscriber address.')
            used.add(address)
            row['assigned_ip'] = str(ipaddress.IPv4Address(address))
        else:
            pending.append((row, first, last))
    # Preserve previous assignments before allocating addresses for new accounts.
    for row, first, last in pending:
        candidate = old.get(row['id'], {}).get('assigned_ip')
        if candidate:
            address = int(ipaddress.IPv4Address(candidate))
            if first <= address <= last and address not in used:
                row['assigned_ip'] = candidate
                used.add(address)
    for row, first, last in pending:
        if 'assigned_ip' not in row:
            address = next((n for n in range(first, last + 1) if n not in used), None)
            require(address is not None, 'Pool is full for ' + row['name'] + '. Expand the pool or remove an account.')
            row['assigned_ip'] = str(ipaddress.IPv4Address(address))
            used.add(address)
    require(not any(r['assigned_ip'] in locals_ for r in result['secrets']), 'Subscriber and local addresses must differ.')
    return result


def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def compile_config(config, directory):
    """Generate private pppd files; do not modify WAN/client secrets or options."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    profiles = {r['id']: r for r in config['profiles']}
    commands = {}
    for server in config['servers']:
        if not server['enabled']:
            continue
        sid = server['id']
        profile = profiles[server['profile']]
        secrets = []
        for account in config['secrets']:
            if account['server'] != sid or not account['enabled']:
                continue
            p = profiles[account['profile'] or server['profile']]
            options = [p['local_ip'] + ':' + account['assigned_ip'], 'ipparam', 'freeisp:' + sid + ':' + account['id']]
            for key in ('dns1', 'dns2'):
                if p[key]:
                    options += ['ms-dns', p[key]]
            secrets.append(' '.join([quote(account['name']), quote('freeisp-' + sid), quote(account['password']), account['assigned_ip'], '--'] + options))
        secretfile = directory / (sid + '.secrets')
        atomic(secretfile, '\n'.join(secrets) + '\n')
        optionsfile = directory / (sid + '.options')
        atomic(optionsfile, '\n'.join([
            'auth', 'require-chap', 'name freeisp-' + sid, 'hide-password',
            'chap-secrets ' + str(secretfile), 'pap-secrets ' + str(secretfile),
            'lcp-echo-interval 10', 'lcp-echo-failure 3', 'nodefaultroute', 'noipv6',
            'nobsdcomp', 'nodeflate', 'novj', 'novjccomp',
            'ip-pre-up-script /usr/libexec/freeisp-pppoe-pre-up',
            'ip-up-script /usr/libexec/freeisp-pppoe-up',
            'ip-down-script /usr/libexec/freeisp-pppoe-down'
        ]) + '\n')
        # pppd's per-account options replace these negotiation placeholders after
        # authentication. Only the assigned address is authorized by its secret.
        commands[sid] = ['/usr/sbin/pppoe-server', '-F', '-k', '-I', server['interface'],
                         '-C', 'FreeISP', '-S', server['name'], '-L', profile['local_ip'],
                         '-R', '10.254.0.1', '-N', str(server['max_sessions']), '-x', '1',
                         '-O', str(optionsfile), '-q', '/usr/libexec/freeisp-pppd']
    return commands


def process_identity(pid):
    try:
        # /proc/stat command names may contain spaces and parentheses.
        text = Path('/proc/' + str(pid) + '/stat').read_text()
        return text[text.rfind(')') + 2:].split()[19]
    except (OSError, IndexError):
        return None


def alive(record):
    pid = record.get('pid', 0)
    return type(pid) is int and pid > 1 and record.get('identity') is not None and process_identity(pid) == record['identity']


def sessions():
    rows = []
    for path in (RUN / 'sessions').glob('*.json'):
        row = read_json(path)
        if not row or not alive(row):
            continue
        device = Path('/sys/class/net') / row['interface']
        if not device.exists():
            continue
        row['uptime'] = max(0, int(time.monotonic() - row['started']))
        for key in ('rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets'):
            try:
                row[key] = int((device / 'statistics' / key).read_text())
            except OSError:
                row[key] = None
        rows.append(row)
    return rows


def status():
    runtime = read_json(RUN / 'status.json', {})
    config = read_json(CONFIG, EMPTY)
    running = runtime.get('servers', {})
    servers = []
    for row in config['servers']:
        process = running.get(row['id'], {})
        is_running = alive(process)
        servers.append({'id': row['id'], 'running': is_running,
                        'state': 'Running' if is_running else 'Stopped' if row['enabled'] else 'Disabled',
                        'error': process.get('error', '')})
    return {'servers': servers, 'sessions': sessions(), 'revision': runtime.get('revision', ''),
            'available': Path('/usr/sbin/pppoe-server').exists() and Path('/usr/sbin/pppd').exists()}


def public_config(config):
    value = copy.deepcopy(config)
    for row in value['secrets']:
        row['has_password'] = bool(row.pop('password', ''))
    return value


def interfaces():
    rows = json.loads(command(['/sbin/ip', '-j', 'link', 'show']))
    return [{'name': r['ifname'], 'up': 'UP' in r.get('flags', [])} for r in rows
            if r.get('link_type') == 'ether' and not r['ifname'].startswith('fi-')]


def initial_config(networks):
    """Choose a subscriber subnet without overlapping existing router addresses."""
    for second in range(79, 255):
        net = ipaddress.ip_network('10.%d.0.0/24' % second)
        if any(net.overlaps(other) for other in networks):
            continue
        config = copy.deepcopy(EMPTY)
        config['pools'] = [{'id': '000000000001', 'name': 'default-pool',
                            'start': str(net.network_address + 2), 'end': str(net.network_address + 254)}]
        config['profiles'] = [{'id': '000000000002', 'name': 'default',
            'pool': '000000000001', 'local_ip': str(net.network_address + 1),
            'dns1': '1.1.1.1', 'dns2': '8.8.8.8', 'download': 0, 'upload': 0}]
        return validate(config)
    raise ValueError('No free default subscriber subnet. Configure a PPPoE pool manually.')


def initialize_defaults():
    with lock():
        current = read_json(CONFIG, EMPTY)
        if current != EMPTY:
            return False  # Never replace existing subscriber settings.
        addresses = json.loads(command(['/sbin/ip', '-j', '-4', 'address', 'show']))
        networks = [ipaddress.ip_network(a['local'] + '/' + str(a['prefixlen']), strict=False)
                    for row in addresses for a in row.get('addr_info', []) if a.get('family') == 'inet']
        write_json(CONFIG, initial_config(networks))
        return True


def check_network(config):
    devices = {r['name']: r for r in interfaces()}
    addresses = json.loads(command(['/sbin/ip', '-j', '-4', 'address', 'show']))
    networks = [ipaddress.ip_network(a['local'] + '/' + str(a['prefixlen']), strict=False)
                for row in addresses if not row['ifname'].startswith(('ppp', 'fi-')) for a in row.get('addr_info', [])]
    for row in config['pools']:
        first, last = ipaddress.IPv4Address(row['start']), ipaddress.IPv4Address(row['end'])
        require(all(last < net.network_address or first > net.broadcast_address for net in networks),
                'Pool ' + row['name'] + ' overlaps an existing router network.')
    for row in config['servers']:
        if row['enabled']:
            require(row['interface'] in devices, 'Server device is missing: ' + row['interface'])
            require(devices[row['interface']]['up'], 'Server device is down: ' + row['interface'])


def restart_and_wait(config):
    command(['/etc/init.d/freeisp-pppoe', 'restart'])
    expected = {r['id'] for r in config['servers'] if r['enabled']}
    stable = 0
    for _ in range(50):
        value = status()
        if value['revision'] == revision(config) and all(r['running'] for r in value['servers'] if r['id'] in expected):
            stable += 1
            if stable >= 5:
                return
        else:
            stable = 0
        time.sleep(.1)
    raise ValueError('PPPoE service did not start. Check device availability and System Log.')


def save(args):
    with lock():
        previous = read_json(CONFIG, EMPTY)
        require(args.get('revision') == revision(previous), 'Settings changed in another session. Reload before saving.')
        config = validate(args.get('config'), previous)
        check_network(config)
        enabled = any(r['enabled'] for r in config['servers'])
        if enabled:
            require(status()['available'], 'Install rp-pppoe-server and ppp before enabling a server.')
            require(Path('/sbin/tc').exists() or not any(r['download'] or r['upload'] for r in config['profiles']), 'Install tc-full for rate limits.')
        write_json(CONFIG, config)
        try:
            restart_and_wait(config)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            write_json(CONFIG, previous)
            try:
                restart_and_wait(previous)
            except (ValueError, OSError, subprocess.SubprocessError):
                raise ValueError('Apply failed. Previous settings were restored on disk, but the service could not be restarted. Check System Log.') from None
            raise ValueError(str(error) + ' Previous settings restored.') from None
        return {'config': public_config(config), 'revision': revision(config), 'status': status()}


def disconnect(args):
    with lock('sessions'):
        record = next((r for r in sessions() if r['id'] == args.get('id')), None)
        require(record is not None, 'This connection has already ended. Refresh the list.')
        # Bind the signal to this kernel process, even if the numeric PID is
        # recycled between checking its start time and sending the signal.
        descriptor = os.pidfd_open(record['pid'])
        try:
            require(alive(record), 'Connection changed. Refresh the list.')
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)
    return {'disconnecting': True}


def rpc(method, args):
    if method == 'get':
        with lock():
            config = read_json(CONFIG, EMPTY)
            return {'config': public_config(config), 'revision': revision(config), 'status': status(), 'interfaces': interfaces()}
    if method == 'status':
        return status()
    if method == 'save':
        return save(args)
    if method == 'disconnect':
        return disconnect(args)
    raise ValueError('Unknown PPPoE operation.')


def serve():
    config = validate(read_json(CONFIG, EMPTY), read_json(CONFIG, EMPTY))
    directory = RUN / 'generated'
    commands = compile_config(config, directory)
    processes, records, next_attempt = {}, {}, {}
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for sid, argv in commands.items():
            # Each group contains only this PPPoE server and its pppd children.
            process = subprocess.Popen(argv, start_new_session=True)
            processes[sid] = process
            records[sid] = {'pid': process.pid, 'identity': process_identity(process.pid)}
        while not stopping:
            for sid, process in processes.items():
                if process.poll() is not None:
                    records[sid]['error'] = 'Server exited with status ' + str(process.returncode) + '. Check System Log and reapply settings.'
                    # Network devices may appear after the init service at boot,
                    # or disappear during a network reload. Retry with visible
                    # stopped state rather than leaving a dead server forever.
                    if sid not in next_attempt:
                        next_attempt[sid] = time.monotonic() + 5
                    elif time.monotonic() >= next_attempt[sid]:
                        replacement = subprocess.Popen(commands[sid], start_new_session=True)
                        processes[sid] = replacement
                        records[sid] = {'pid': replacement.pid, 'identity': process_identity(replacement.pid)}
                        del next_attempt[sid]
            write_json(RUN / 'status.json', {'revision': revision(config), 'servers': records})
            time.sleep(.25)
    finally:
        for process in processes.values():
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 3
        for process in processes.values():
            try:
                process.wait(timeout=max(.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        # pppd may create a separate process group. Terminate only tracked sessions.
        for row in sessions():
            if alive(row):
                os.kill(row['pid'], signal.SIGTERM)
        write_json(RUN / 'status.json', {'revision': '', 'servers': {}})


def hook(action, argv):
    require(len(argv) == 6, 'Invalid PPP hook arguments.')
    interface, _, _, local_ip, remote_ip, parameter = argv
    require(re.fullmatch(r'fi-\d+', interface), 'Invalid session device.')
    require(re.fullmatch(r'freeisp:[a-f0-9]{12}:[a-f0-9]{12}', parameter), 'Invalid session identity.')
    _, sid, aid = parameter.split(':')
    pid = int(os.environ['PPPD_PID'])
    token = process_identity(pid)
    require(token is not None, 'Session process is missing.')
    session_id = str(pid) + '-' + token
    path = RUN / 'sessions' / (session_id + '.json')
    if action == 'down':
        path.unlink(missing_ok=True)
        return
    config = read_json(CONFIG, EMPTY)
    account = next((r for r in config['secrets'] if r['id'] == aid and r['server'] == sid and r['enabled']), None)
    server = next((r for r in config['servers'] if r['id'] == sid and r['enabled']), None)
    require(account is not None and server is not None, 'Account or server is disabled.')
    profile = next(r for r in config['profiles'] if r['id'] == (account['profile'] or server['profile']))
    require(os.environ.get('PEERNAME') == account['name'] and account['assigned_ip'] == remote_ip and profile['local_ip'] == local_ip, 'Subscriber address or identity mismatch.')
    if action == 'pre-up':
        with lock('sessions'):
            # Stable reservations require one session per account, across MACs.
            duplicate = any(r['account'] == aid and r['id'] != session_id for r in sessions())
            require(not duplicate, 'This account already has an active connection.')
            target = interface
            if profile['download']:
                command(['/sbin/tc', 'qdisc', 'replace', 'dev', target, 'root', 'tbf', 'rate', str(profile['download']) + 'kbit', 'burst', '64kb', 'latency', '100ms'])
            if profile['upload']:
                command(['/sbin/tc', 'qdisc', 'replace', 'dev', target, 'handle', 'ffff:', 'ingress'])
                command(['/sbin/tc', 'filter', 'replace', 'dev', target, 'parent', 'ffff:', 'protocol', 'all', 'u32', 'match', 'u32', '0', '0', 'police', 'rate', str(profile['upload']) + 'kbit', 'burst', '64kb', 'drop', 'flowid', ':1'])
            write_json(path, {'id': session_id, 'pid': pid, 'identity': token, 'account': aid, 'server': sid,
                              'name': account['name'], 'profile': profile['name'], 'interface': target,
                              'address': remote_ip, 'caller_id': os.environ.get('REMOTENUMBER', ''),
                              'started': time.monotonic()})


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "initialize":
        initialize_defaults()
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        serve()
        return
    if len(sys.argv) > 2 and sys.argv[1] == 'hook':
        try:
            hook(sys.argv[2], sys.argv[3:])
        except Exception as error:
            # Fail closed: pppd ignores hook exit codes, so terminate the parent.
            print('FreeISP PPPoE hook rejected: ' + str(error), file=sys.stderr)
            pid = int(os.environ.get('PPPD_PID', '0'))
            if pid > 1 and sys.argv[2] != 'down':
                os.kill(pid, signal.SIGTERM)
            sys.exit(1)
        return
    if len(sys.argv) == 2 and sys.argv[1] == 'list':
        print(json.dumps({'get': {}, 'status': {}, 'save': {'config': {}, 'revision': ''}, 'disconnect': {'id': ''}}))
        return
    try:
        require(len(sys.argv) == 3 and sys.argv[1] == 'call', 'Invalid invocation.')
        raw = sys.stdin.read(2 * 1024 * 1024 + 1)
        require(len(raw) <= 2 * 1024 * 1024, 'Request is too large.')
        result = rpc(sys.argv[2], json.loads(raw or '{}'))
        print(json.dumps(result))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        # Validation text is safe; unexpected system failures must not echo data.
        error = sys.exc_info()[1]
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'PPPoE operation failed. Check System Log and reload.'}))


if __name__ == '__main__':
    main()
