"""Real customer VM probe; only invoked by the explicit lab client boot flag."""
import json
import socket
import ssl
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

checks = {}
try:
    iface = next(p.parent.name for p in Path('/sys/class/net').glob('*/address')
                 if p.read_text().strip() == '52:54:00:f1:10:01')
    subprocess.run(['ip', 'link', 'set', iface, 'up'], check=True)
    subprocess.run(['udhcpc', '-n', '-q', '-i', iface, '-s', '/usr/lib/freeisp/lease.py',
                    '-t', '8', '-T', '2'], check=True, timeout=25)
    addresses = json.loads(subprocess.check_output(['ip', '-j', 'address', 'show', iface]))
    assigned = [a['local'] for a in addresses[0]['addr_info'] if a['family'] == 'inet']
    checks['dhcp_real_packets'] = any(a.startswith('10.77.0.') and 100 <= int(a.split('.')[-1]) <= 199 for a in assigned)
    Path('/etc/resolv.conf').write_text(Path('/run/wan-resolv.conf').read_text())
    checks['dns_real_packets'] = socket.gethostbyname('freeisp.lan') == '10.77.0.1'
    with urllib.request.urlopen('http://10.0.2.2:18090/witness', timeout=8) as reply:
        checks['routed_http_to_upstream'] = reply.read() == b'FreeISP upstream witness\n'
    try:
        urllib.request.urlopen('https://10.77.0.1:8443/api/status',
                               context=ssl._create_unverified_context(), timeout=5)
        checks['lan_management_requires_auth'] = False
    except urllib.error.HTTPError as exc:
        checks['lan_management_requires_auth'] = exc.code == 401
    try:
        with socket.create_connection(('10.78.0.2', 18090), timeout=3):
            checks['customer_cannot_forward_into_maintenance'] = False
    except OSError:
        checks['customer_cannot_forward_into_maintenance'] = True
    try:
        with socket.create_connection(('10.78.0.15', 8080), timeout=3):
            checks['customer_cannot_access_plain_maintenance'] = False
    except OSError:
        checks['customer_cannot_access_plain_maintenance'] = True
except Exception as exc:
    checks['error'] = str(exc)
print('FREEISP_CLIENT_RESULT=' + json.dumps(checks), flush=True)
