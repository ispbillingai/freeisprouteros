import socket
import sys
import time
s=socket.socket(socket.AF_UNIX)
s.settimeout(2)
s.connect('/tmp/freeisp-tools-console.sock')
command=' '.join(sys.argv[1:])
if command=='--setup':
    command="sed -i 's/\\r$//' /etc/uci-defaults/99-freeisp; sh /etc/uci-defaults/99-freeisp; /etc/init.d/network restart; /etc/init.d/uhttpd restart"
if command=='--test-acl':
    command="printf '%s' '{\"freeisp-tools-test\":{\"read\":{\"ubus\":{\"file\":[\"read\",\"exec\"]},\"file\":{\"*\":[\"read\",\"exec\"]}},\"write\":{\"ubus\":{\"file\":[\"write\",\"exec\"]},\"file\":{\"*\":[\"write\",\"exec\"]}}}}' > /usr/share/rpcd/acl.d/freeisp-tools-test.json; /etc/init.d/rpcd restart"
s.sendall(('\n'+command+'\n').encode())
end=time.monotonic()+8
while time.monotonic()<end:
    try:
        data=s.recv(65536)
        if not data: break
        print(data.decode(errors='replace'),end='',flush=True)
    except TimeoutError:
        pass
