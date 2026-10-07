#!/bin/sh
# Run only inside the disposable OpenWrt root created by bridge-test-image.sh.
set -eu
[ "${FREEISP_BRIDGE_TEST_ISOLATED:-}" = 1 ] || { echo 'Disposable test environment required'; exit 2; }
check() { if "$@"; then echo "PASS $*"; else echo "FAIL $*"; exit 1; fi; }
cleanup() {
    for pid in ${netpid:-} ${rpcpid:-} ${ubuspid:-}; do kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; done
    ip netns del bridge-client-a 2>/dev/null || :
    ip netns del bridge-client-b 2>/dev/null || :
}
trap cleanup EXIT INT TERM
mkdir -p /var/run /var/state /var/lock /tmp/run
ubusd >/tmp/ubusd.log 2>&1 & ubuspid=$!
sleep 1
ip link set lo up
ip link add test-a type veth peer name peer-a
ip link add test-b type veth peer name peer-b
peer_mac=$(cat /sys/class/net/peer-a/address)
ip netns add bridge-client-a
ip netns add bridge-client-b
ip link set peer-a netns bridge-client-a
ip link set peer-b netns bridge-client-b
ip -n bridge-client-a link set lo up
ip -n bridge-client-a link set peer-a up
ip -n bridge-client-b link set lo up
ip -n bridge-client-b link set peer-b up
cat > /etc/config/network <<'EOF'
config device 'test_bridge'
 option name 'br-test'
 option type 'bridge'
 list ports 'test-a'
 list ports 'test-b'
 option stp '0'
 option vlan_filtering '1'
 option mtu '1400'
 option igmp_snooping '1'
config device 'test_port'
 option name 'test-a'
 option learning '1'
 option isolate '1'
config bridge-vlan 'test_vlan'
 option device 'br-test'
 option vlan '20'
 option local '1'
 list ports 'test-a:u*'
 list ports 'test-b:t'
config interface 'test'
 option proto 'static'
 option device 'br-test.20'
 option ipaddr '192.0.2.1'
 option netmask '255.255.255.0'
EOF
netifd >/tmp/netifd.log 2>&1 & netpid=$!
for i in 1 2 3 4 5 6 7 8 9 10; do ip link show br-test >/dev/null 2>&1 && break; sleep 1; done
sleep 2
check ip link show br-test
check test "$(cat /sys/class/net/br-test/mtu)" = 1400
check test "$(cat /sys/class/net/br-test/bridge/vlan_filtering)" = 1
check test "$(cat /sys/class/net/test-a/brport/isolated)" = 1
check test "$(cat /sys/class/net/test-a/brport/learning)" = 1
bridge -j -d -s link show > /tmp/bridge-link.json
bridge -j vlan show > /tmp/bridge-vlan.json
check grep -q 'PVID' /tmp/bridge-vlan.json
check grep -q '20' /tmp/bridge-vlan.json
check ip link show br-test.20
# A peer sends real frames so the bridge forwarding database learns its MAC.
ip -n bridge-client-a addr add 192.0.2.2/24 dev peer-a
check ip netns exec bridge-client-a ping -c 2 -W 2 192.0.2.1
ip -n bridge-client-b link add link peer-b name peer-b.20 type vlan id 20
ip -n bridge-client-b link set peer-b.20 up
ip -n bridge-client-b addr add 192.0.2.3/24 dev peer-b.20
check ip netns exec bridge-client-b ping -I peer-b.20 -c 2 -W 2 192.0.2.1
ip -n bridge-client-b link add link peer-b name peer-b.21 type vlan id 21
ip -n bridge-client-b link set peer-b.21 up
ip -n bridge-client-b addr add 192.0.2.4/24 dev peer-b.21
if ip netns exec bridge-client-b ping -I peer-b.21 -c 1 -W 2 192.0.2.1; then echo 'FAIL unconfigured VLAN passed traffic'; exit 1; fi
echo 'PASS unconfigured VLAN is blocked'
bridge -j -s fdb show > /tmp/bridge-fdb.json
check grep -q "$peer_mac" /tmp/bridge-fdb.json
/usr/libexec/freeisp-bridge-status > /tmp/bridge-helper.json
check test "$(jsonfilter -i /tmp/bridge-helper.json -e '@.fdb.code')" = 0
if /usr/libexec/freeisp-bridge-status unexpected; then echo 'FAIL helper accepted arguments'; exit 1; fi
echo 'PASS helper rejects caller arguments'
# Authentication fixture belongs only to this disposable image and has no network listener.
sed -i 's/^root:[^:]*:/root::/' /etc/shadow
cat > /etc/config/rpcd <<'EOF'
config login 'reader'
 option username 'bridge-reader'
 option password '$p$root'
 list read 'luci-app-freeisp-bridge'
config login 'writer'
 option username 'bridge-writer'
 option password '$p$root'
 list read 'luci-app-freeisp-bridge'
 list write 'luci-app-freeisp-bridge'
EOF
rpcd >/tmp/rpcd.log 2>&1 & rpcpid=$!
sleep 1
reader=$(ubus call session login '{"username":"bridge-reader","password":""}' | jsonfilter -e '@.ubus_rpc_session')
writer=$(ubus call session login '{"username":"bridge-writer","password":""}' | jsonfilter -e '@.ubus_rpc_session')
check test -n "$reader"
check test -n "$writer"
ubus call file exec "{\"ubus_rpc_session\":\"$reader\",\"command\":\"/usr/libexec/freeisp-bridge-status\",\"params\":[]}" > /tmp/helper-rpc.json
check test "$(jsonfilter -i /tmp/helper-rpc.json -e '@.code')" = 0
if ubus call file exec "{\"ubus_rpc_session\":\"$reader\",\"command\":\"/bin/echo\",\"params\":[\"denied\"]}"; then echo 'FAIL unrestricted command permitted'; exit 1; fi
if ubus call file exec '{"ubus_rpc_session":"00000000000000000000000000000000","command":"/usr/libexec/freeisp-bridge-status","params":[]}'; then echo 'FAIL anonymous telemetry permitted'; exit 1; fi
if ubus call uci set "{\"ubus_rpc_session\":\"$reader\",\"config\":\"network\",\"section\":\"test_bridge\",\"values\":{\"mtu\":\"1370\"}}"; then echo 'FAIL read-only write permitted'; exit 1; fi
ubus call uci set "{\"ubus_rpc_session\":\"$writer\",\"config\":\"network\",\"section\":\"test_bridge\",\"values\":{\"mtu\":\"1370\"}}"
ubus call uci get "{\"ubus_rpc_session\":\"$writer\",\"config\":\"network\",\"section\":\"test_bridge\"}" > /tmp/uci-rpc.json
check test "$(jsonfilter -i /tmp/uci-rpc.json -e '@.values.mtu')" = 1370
ubus call uci revert "{\"ubus_rpc_session\":\"$writer\",\"config\":\"network\"}"
echo 'PASS real RPC helper execution, least-privilege ACL and UCI writes'
uci set network.test_bridge.mtu='1380'
uci set network.test_port.isolate='0'
uci commit network
ubus call network reload
sleep 2
check test "$(cat /sys/class/net/br-test/mtu)" = 1380
check test "$(cat /sys/class/net/test-a/brport/isolated)" = 0
kill "$netpid"; wait "$netpid" || :; netpid=''
netifd >/tmp/netifd-restart.log 2>&1 & netpid=$!
sleep 3
check test "$(cat /sys/class/net/br-test/mtu)" = 1380
check test "$(uci get network.test_bridge.mtu)" = 1380
echo 'PASS settings survive netifd restart and fresh UCI read'
uci delete network.test_vlan
uci set network.test.device='br-test'
uci set network.test_bridge.vlan_filtering='0'
uci del_list network.test_bridge.ports='test-b'
uci commit network
ubus call network reload
sleep 2
check test ! -e /sys/class/net/test-b/brport
uci delete network.test
uci delete network.test_bridge
uci commit network
ubus call network reload
sleep 2
check test ! -e /sys/class/net/br-test
echo 'PASS VLAN removal, port detach and bridge removal'
echo 'PASS real OpenWrt netifd/UCI bridge backend'
