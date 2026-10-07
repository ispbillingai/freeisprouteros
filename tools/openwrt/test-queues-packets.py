"""Packet and ACL checks; ONLY use an isolated, disposable local OpenWrt VM.

Run on the QEMU host with FREEISP_QUEUE_TEST_DISPOSABLE=yes,
FREEISP_QUEUE_TEST_URL and FREEISP_QUEUE_TEST_CREDENTIALS set. Test traffic
stays between this local HTTP witness and the guest. No internet is required.
"""
import http.server
import json
import os
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request

assert os.environ.get('FREEISP_QUEUE_TEST_DISPOSABLE') == 'yes'
url = os.environ['FREEISP_QUEUE_TEST_URL']
assert urllib.parse.urlparse(url).hostname in ('127.0.0.1', 'localhost')
password = json.loads(Path(os.environ['FREEISP_QUEUE_TEST_CREDENTIALS']).read_text())['password']
sid = '0' * 32
checks = {}
out = Path('artifacts/tests/queues-packets')
out.mkdir(parents=True, exist_ok=True)


def rpc(obj, method, args=None, session=None, required=True):
    payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'call',
               'params': [session or sid, obj, method, args or {}]}
    request = urllib.request.Request(url + '/ubus', data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        value = json.load(response)
        result = value.get('result', [value.get('error', {}).get('code', -1)])
    if required:
        assert result[0] == 0, (obj, method, result[0])
        return result[1] if len(result) > 1 else {}
    return result


def execute(command, params, session=None):
    result = rpc('file', 'exec', {'command': command, 'params': params}, session)
    assert result['code'] == 0, result.get('stderr')
    return result.get('stdout', '')


class Witness(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', str(512 * 1024))
        self.end_headers()
        self.wfile.write(bytes(512 * 1024))

    def do_PUT(self):
        remaining = int(self.headers['Content-Length'])
        while remaining:
            data = self.rfile.read(min(65536, remaining))
            if not data:
                break
            remaining -= len(data)
        assert remaining == 0
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *_):
        pass


sid = rpc('session', 'login', {'username': 'root', 'password': password})['ubus_rpc_session']
before = rpc('uci', 'get', {'config': 'sqm'})['values']
assert 'queue_packets' not in before
assert not any(s.get('enabled') == '1' and s.get('interface') == 'eth0' for s in before.values())
server = http.server.ThreadingHTTPServer(('127.0.0.1', 18992), Witness)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    rpc('uci', 'add', {'config': 'sqm', 'type': 'queue', 'name': 'queue_packets', 'values': {
        'enabled': '1', 'interface': 'eth0', 'upload': '1000', 'download': '2000',
        'qdisc': 'cake', 'script': 'piece_of_cake.qos'}})
    rpc('uci', 'commit', {'config': 'sqm'})
    execute('/etc/init.d/sqm', ['reload'])
    execute('/usr/bin/curl', ['--fail', '--max-time', '30', '-o', '/tmp/queue-payload', 'http://10.0.2.2:18992/payload'])
    start = time.monotonic()
    execute('/usr/bin/curl', ['--fail', '--max-time', '30', '-T', '/tmp/queue-payload', 'http://10.0.2.2:18992/upload'])
    upload_seconds = time.monotonic() - start
    start = time.monotonic()
    execute('/usr/bin/curl', ['--fail', '--max-time', '30', '-o', '/dev/null', 'http://10.0.2.2:18992/payload'])
    download_seconds = time.monotonic() - start
    kernel = json.loads(execute('/sbin/tc', ['-s', '-j', 'qdisc', 'show']))
    upload = next(q for q in kernel if q['dev'] == 'eth0' and q.get('root'))
    download = next(q for q in kernel if q['dev'].startswith('ifb') and q.get('root'))
    assert upload['bytes'] >= 512 * 1024 and download['bytes'] >= 512 * 1024
    assert upload['options']['bandwidth'] == 125000
    assert download['options']['bandwidth'] == 250000
    assert upload_seconds >= 3.0 and download_seconds >= 1.5
    checks['traffic_crossed_both_shapers'] = True
    checks['512_KiB_upload_seconds_including_rpc'] = round(upload_seconds, 3)
    checks['512_KiB_download_seconds_including_rpc'] = round(download_seconds, 3)
    checks['upload_counter_bytes'] = upload['bytes']
    checks['download_counter_bytes'] = download['bytes']
    # Test an actual rpcd login with just the feature ACL, not the harness ACL.
    for name, write in [('queue_reader', False), ('queue_writer', True)]:
        execute('/sbin/uci', ['set', 'rpcd.' + name + '=login'])
        execute('/sbin/uci', ['set', 'rpcd.' + name + '.username=' + name])
        execute('/sbin/uci', ['set', 'rpcd.' + name + '.password=$p$root'])
        for acl in ['luci-base', 'luci-app-freeisp-queues']:
            execute('/sbin/uci', ['add_list', 'rpcd.' + name + '.read=' + acl])
        if write:
            execute('/sbin/uci', ['add_list', 'rpcd.' + name + '.write=luci-app-freeisp-queues'])
    execute('/sbin/uci', ['commit', 'rpcd'])
    reader = rpc('session', 'login', {'username': 'queue_reader', 'password': password}, session='0'*32)['ubus_rpc_session']
    rpc('uci', 'get', {'config': 'sqm'}, reader)
    rpc('uci', 'changes', {'config': 'sqm'}, reader)
    rpc('file', 'list', {'path': '/var/run/sqm/available_qdiscs'}, reader)
    rpc('file', 'list', {'path': '/usr/lib/sqm'}, reader)
    rpc('luci-rpc', 'getNetworkDevices', {}, reader)
    execute('/sbin/tc', ['-s', '-j', 'qdisc', 'show'], reader)
    assert rpc('uci', 'set', {'config': 'sqm', 'section': 'queue_packets', 'values': {'upload': '1'}}, reader, False)[0] in (6, -32002)
    assert rpc('file', 'exec', {'command': '/etc/init.d/sqm', 'params': ['enable']}, reader, False)[0] in (6, -32002)
    checks['read_only_acl_reads_status_and_denies_writes'] = True
    writer = rpc('session', 'login', {'username': 'queue_writer', 'password': password}, session='0'*32)['ubus_rpc_session']
    rpc('uci', 'set', {'config': 'sqm', 'section': 'queue_packets', 'values': {'upload': '1500'}}, writer)
    execute('/etc/init.d/sqm', ['enable'], writer)
    rpc('uci', 'apply', {'rollback': True, 'timeout': 30}, writer)
    rpc('uci', 'confirm', {}, writer)
    for _ in range(10):
        kernel = json.loads(execute('/sbin/tc', ['-s', '-j', 'qdisc', 'show'], writer))
        if any(q['dev'] == 'eth0' and q.get('root') and q.get('options', {}).get('bandwidth') == 187500 for q in kernel):
            break
        time.sleep(1)
    else:
        raise AssertionError('Writer-applied queue did not reach the kernel')
    assert rpc('uci', 'set', {'config': 'network', 'section': 'wan', 'values': {'proto': 'static'}}, writer, False)[0] in (6, -32002)
    checks['writer_acl_applies_queue_and_denies_network_changes'] = True
    print(json.dumps(checks, indent=2))
finally:
    rpc('uci', 'delete', {'config': 'sqm', 'section': 'queue_packets'})
    rpc('uci', 'commit', {'config': 'sqm'})
    execute('/etc/init.d/sqm', ['reload'])
    for name in ['queue_reader', 'queue_writer']:
        rpc('file', 'exec', {'command': '/sbin/uci', 'params': ['-q', 'delete', 'rpcd.' + name]})
    execute('/sbin/uci', ['commit', 'rpcd'])
    execute('/bin/rm', ['-f', '/tmp/queue-payload'])
    server.shutdown()
    assert rpc('uci', 'get', {'config': 'sqm'})['values'] == before
    (out/'result.json').write_text(json.dumps(checks, indent=2))
