"""Local STARTTLS SMTP sink; never forwards messages to a real recipient."""
import base64
import json
import socketserver
import ssl
import subprocess
import threading
from pathlib import Path

from tools_vm_client import rpc, execute, ROOT, login
login()
out=ROOT/'artifacts/tools-vm'; checks={}; received=[]
cert=out/'smtp-test.crt'; key=out/'smtp-test.key'
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=10.0.2.2','-addext','subjectAltName=IP:10.0.2.2'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key)
class SMTP(socketserver.BaseRequestHandler):
    def handle(self):
        sock=self.request;sock.settimeout(15); reader=sock.makefile('rb'); secure=False; authenticated=False
        def reply(value):sock.sendall((value+'\r\n').encode())
        reply('220 local-fixture ESMTP')
        while True:
            line=reader.readline().decode().rstrip('\r\n')
            if not line: return
            command=line.split(' ',1)[0].upper()
            if command in ['EHLO','HELO']:
                reply('250-local-fixture');reply('250-AUTH PLAIN' if secure else '250-STARTTLS');reply('250 8BITMIME')
            elif command=='STARTTLS':
                reply('220 Ready');reader.close();sock=tls.wrap_socket(sock,server_side=True);reader=sock.makefile('rb');secure=True
            elif command=='AUTH':
                credentials=base64.b64decode(line.split(' ')[-1]).split(b'\0')
                authenticated=secure and credentials[-2:]==[b'test',b"test'quote-secret"]
                reply('235 authenticated' if authenticated else '535 invalid')
            elif command in ['MAIL','RCPT']:
                reply('250 accepted' if authenticated else '530 authenticate')
            elif command=='DATA':
                reply('354 End with dot');body=[]
                while True:
                    line=reader.readline()
                    if line==b'.\r\n':break
                    if not line:return
                    body.append(line)
                received.append(b''.join(body));reply('250 queued locally')
            elif command=='QUIT':reply('221 Bye');return
            else:reply('250 OK')

server=socketserver.ThreadingTCPServer(('127.0.0.1',0),SMTP)
threading.Thread(target=server.serve_forever,daemon=True).start()
ca_path='/etc/ssl/certs/ca-certificates.crt'
execute('/bin/cp',[ca_path,'/tmp/freeisp-tools-original-ca'])
try:
    rpc('file','write',{'path':ca_path,'data':cert.read_text(),'mode':420})
    result=rpc('freeisp.tools','save',{'section':'email','host':'10.0.2.2','port':str(server.server_address[1]),'from':'sender@example.invalid','username':'test','password':"test'quote-secret"})
    checks['smtp_settings_saved']=result['ok']
    result=rpc('freeisp.tools','run',{'tool':'email','to':'recipient@example.invalid','subject':'Local fixture only','message':'FreeISP TLS SMTP test'})
    checks['smtp_starttls_authenticated_send']=result['ok']
    checks['smtp_received_exact_message']=len(received)==1 and b'FreeISP TLS SMTP test' in received[0]
    if not result['ok']: print(result)
    result=rpc('freeisp.tools','run',{'tool':'email','to':'recipient@example.invalid','subject':'bad\r\nBcc: other@example.invalid','message':'Must not send'})
    checks['mail_header_injection_rejected']=not result['ok'] and len(received)==1
    print(json.dumps(checks,indent=2))
finally:
    execute('/bin/cp',['/tmp/freeisp-tools-original-ca',ca_path])
    rpc('freeisp.tools','save',{'section':'email','host':'localhost','port':'587','from':'test@example.invalid','username':'','clear_password':'1'})
    server.shutdown();server.server_close()
    (out/'smtp-checks.json').write_text(json.dumps(checks,indent=2))
if not checks or not all(checks.values()): raise SystemExit(1)
