"""Integration checks against the disposable local VM started by tools-vm.sh.

Only loopback port 18940 is used. No production credentials or router are used.
"""
import json
import sys
import time
import concurrent.futures
import socket
import tools_vm_client as client
from tools_vm_client import rpc, execute, ROOT
client.login()

if '--inspect' in sys.argv:
    print(json.dumps(execute('/usr/bin/ucode', ['/usr/libexec/rpcd/freeisp.tools', 'list']), indent=2))
    print(json.dumps(execute('/bin/sh', ['-c', 'command -v timeout; command -v ping; command -v top; command -v nc; ls /usr/libexec/rpcd']), indent=2))
    sys.exit()

if '--sync' in sys.argv:
    for base in ['usr/libexec/rpcd', 'usr/share/freeisp', 'www/luci-static/resources/view/freeisp']:
        for path in (ROOT / 'openwrt/files' / base).glob('*'):
            if path.is_file():
                rpc('file', 'write', {'path': '/' + base + '/' + path.name, 'data': path.read_text(), 'mode': 493 if base.endswith('rpcd') else 420})
    print(execute('/usr/bin/ucode', ['/usr/libexec/rpcd/freeisp.tools', 'list']))
    # Existing rpcd methods invoke this executable on every call; no daemon restart needed.
    sys.exit()

if '--install' in sys.argv:
    print(execute('/bin/sh', ['-c', '(apk update && apk add coreutils-timeout iputils-ping iperf3 fping etherwake msmtp ca-bundle) >/tmp/tools-install.log 2>&1 &']))
    sys.exit()

if '--install-status' in sys.argv:
    print(execute('/bin/cat', ['/tmp/tools-install.log']))
    sys.exit()

if '--status' in sys.argv:
    print(json.dumps(rpc('freeisp.tools', 'status'), indent=2))
    sys.exit()
if '--run' in sys.argv:
    print(json.dumps(rpc('freeisp.tools','run',json.loads(sys.argv[-1])),indent=2))
    sys.exit()
if '--capture' in sys.argv:
    print(rpc('freeisp.tools','run',{'tool':'sniffer','interface':'lo'}))
    sys.exit()
if '--email' in sys.argv:
    print(rpc('freeisp.tools','save',{'section':'email','host':'localhost','port':'587','from':'test@example.invalid','username':'test','password':'private-test-secret'}))
    sys.exit()

checks = {}
def check(name, condition):
    checks[name] = bool(condition)
    print(name + ': ' + ('PASS' if condition else 'FAIL'), flush=True)
    if not condition: raise AssertionError(name)

def run(tool, **params):
    return rpc('freeisp.tools', 'run', {'tool':tool, **{k:str(v) for k,v in params.items()}})

def save(section, **params):
    return rpc('freeisp.tools', 'save', {'section':section, **{k:str(v) for k,v in params.items()}})

try:
    status=rpc('freeisp.tools', 'status')
    baseline_board=rpc('system','board')
    check('all_20_tools_reported', status['ok'] and len(status['tools']) == 20)
    check('proprietary_protocols_honestly_unavailable', all(not t['available'] for t in status['tools'] if t['id'] in ['mac','romon']))
    original=client.SID; client.SID='0'*32
    denied=rpc('freeisp.tools','run',{'tool':'ping','host':'127.0.0.1'},False)
    check('anonymous_execution_denied', isinstance(denied,int) and denied != 0)
    client.SID=original
    for tool in ['ping','flood','speed','traceroute']:
        result=run(tool,host='127.0.0.1')
        if not result['ok']: print(result,flush=True)
        check(tool+'_loopback',result['ok'] and '127.0.0.1' in result['output'])
    for tool in ['graph','monitor','profile']:
        result=run(tool)
        check(tool+'_real_kernel_data',result['ok'] and len(result['output'])>50)
    check('invalid_host_rejected', not run('ping',host='127.0.0.1; touch /tmp/tools-injected')['ok'])
    check('option_injection_rejected', not run('ping',host='-f')['ok'])
    check('invalid_device_rejected', not run('sniffer',interface='../etc/passwd')['ok'])
    check('oversized_scan_rejected', not run('scan',host='10.0.0.0/8')['ok'])
    check('invalid_scan_octet_rejected', not run('scan',host='999.0.0.0/28')['ok'])
    check('invalid_mac_rejected', not run('wol',interface='lo',mac='bad')['ok'])
    check('excessive_generator_rate_rejected', not run('generator',host='127.0.0.1',port=5201,rate=1000)['ok'])
    check('unassigned_server_address_rejected', not save('btest',enabled=1,address='192.0.2.253',port=5201)['ok'])
    check('server_enable_saved',save('btest',enabled=1,address='127.0.0.1',port=5201)['ok'])
    time.sleep(2)
    status=rpc('freeisp.tools','status')
    check('server_process_running',status['services']['freeisp-tools']['instances']['bandwidth']['running'])
    for tool in ['bandwidth','generator']:
        result=run(tool,host='127.0.0.1',port=5201,rate=1)
        check(tool+'_real_traffic',result['ok'] and json.loads(result['output'])['end']['sum_sent']['bytes']>0)
    check('bandwidth_refused_connection_reported',not run('bandwidth',host='127.0.0.1',port=59999)['ok'])
    check('telnet_refused_connection_reported',not run('telnet',host='127.0.0.1',port=59999)['ok'])
    check('ip_scan_loopback', '127.0.0.1' in run('scan',host='127.0.0.1/32')['output'])
    with concurrent.futures.ThreadPoolExecutor() as pool:
        capture=pool.submit(run,'sniffer',interface='lo')
        time.sleep(.4)
        run('ping',host='127.0.0.1')
        captured=capture.result()
    check('bounded_capture',captured['ok'] and 'ICMP' in captured['output'])
    check('bounded_torch',run('torch',interface='lo')['ok'])
    check('wake_packet_send',run('wol',interface='eth1',mac='02:00:00:00:00:01')['ok'])
    with concurrent.futures.ThreadPoolExecutor() as pool:
        witness=pool.submit(execute,'/usr/bin/timeout',['5','tcpdump','-nn','-e','-c','1','-i','eth1','ether','proto','0x0842'])
        time.sleep(.4)
        run('wol',interface='eth1',mac='02:00:00:00:00:01')
        packet=witness.result()
    check('wake_magic_packet_observed',packet['code']==0 and '0x0842' in packet.get('stdout',''))
    check('netwatch_saved',save('netwatch',enabled=1,host='127.0.0.1',interval=10)['ok'])
    time.sleep(3)
    watch=rpc('freeisp.tools','status')['watch']
    check('netwatch_live_probe',watch and watch['up'] and time.time()-watch['checked_at']<15)
    check('netwatch_unreachable_target_saved',save('netwatch',enabled=1,host='192.0.2.1',interval=10)['ok'])
    time.sleep(7)
    watch=rpc('freeisp.tools','status')['watch']
    check('netwatch_down_reported',watch and watch['host']=='192.0.2.1' and not watch['up'])
    check('smtp_settings_persist',save('email',host='localhost',port=587,**{'from':'test@example.invalid','username':'test','password':'private-test-secret'})['ok'])
    s=rpc('freeisp.tools','status')['settings']['email']
    check('smtp_password_not_exposed',s['password_saved'] and 'password' not in s and s['host']=='localhost')
    check('smtp_connection_failure_reported',not run('email',to='recipient@example.invalid',subject='Local failure test',message='Not delivered')['ok'])
    check('sms_missing_dependency_reported',not run('sms',modem=0,phone='+10000000000',message='Local test')['ok'])
    check('server_disable_saved',save('btest',enabled=0,address='127.0.0.1',port=5201)['ok'])
    check('netwatch_disable_saved',save('netwatch',enabled=0,host='127.0.0.1',interval=10)['ok'])
    time.sleep(1)
    service=rpc('freeisp.tools','status')['services'].get('freeisp-tools',{})
    check('disabled_services_stopped',not any(i.get('running') for i in service.get('instances',{}).values()))
    check('existing_board_status',rpc('system','board')['hostname']==baseline_board['hostname'])
    check('existing_network_status',len(rpc('network.interface','dump')['interface'])>=3)
    check('existing_dhcp_settings',rpc('uci','get',{'config':'dhcp'})['values']['lan']['start']=='100')
    check('persistence_settings_saved',save('btest',enabled=1,address='127.0.0.1',port=5201)['ok'] and save('netwatch',enabled=1,host='127.0.0.1',interval=20)['ok'])
    with socket.socket(socket.AF_UNIX) as console:
        console.connect('/tmp/freeisp-tools-console.sock');console.sendall(b'\nreboot\n')
    time.sleep(5)
    client.SID='0'*32
    for attempt in range(45):
        try:
            client.SID=rpc('session','login',{'username':'root','password':'FreeISP-Tools-Local-Test-Only'})['ubus_rpc_session']
            status=rpc('freeisp.tools','status')
            if status['services'].get('freeisp-tools',{}).get('instances',{}).get('bandwidth',{}).get('running'):break
        except Exception:pass
        time.sleep(2)
    check('settings_survive_guest_reboot',status['settings']['btest']['enabled']=='1' and status['settings']['netwatch']['interval']=='20')
    check('server_restarts_after_reboot',status['services']['freeisp-tools']['instances']['bandwidth']['running'])
    check('persistent_services_cleanup',save('btest',enabled=0,address='127.0.0.1',port=5201)['ok'] and save('netwatch',enabled=0,host='127.0.0.1',interval=20)['ok'])
    check('suite_complete',True)
finally:
    out=ROOT/'artifacts/tools-vm/checks.json'
    out.write_text(json.dumps({'checks':checks,'passed':checks.get('suite_complete',False) and all(checks.values())},indent=2))
