const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = new Function('baseclass', fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/bridge-data.js', 'utf8'))({extend: x => x});
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const bridge = {'.name': 'br', '.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth1', 'eth2']};
const vlan = {'.name': 'v10', '.type': 'bridge-vlan', device: 'br-lan', vlan: '10', local: '1', ports: ['eth1:u*', 'eth2:t']};
const sections = [bridge, vlan, {'.name': 'lan', '.type': 'interface', device: 'br-lan.10', proto: 'static'}];
test('Bridge creation validates names, unicast MAC and STP timer constraints', () => {
    assert.equal(data.validateBridge({name: 'br-new', stp: '1'}, sections, []).type, 'bridge');
    for (const name of ['br-lan', 'lo', 'bad name', '../tmp', 'bridge-name-too-long']) assert.throws(() => data.validateBridge({name}, sections, []));
    assert.throws(() => data.validateBridge({name: 'eth0'}, sections, ['eth0']));
    for (const macaddr of ['00:00:00:00:00:00', '01:12:34:56:78:90', 'zz:12:34:56:78:90']) assert.throws(() => data.validateBridge({name: 'br-new', macaddr}, [], []));
    assert.throws(() => data.validateBridge({name: 'br-new', stp: '1', hello_time: '10', max_age: '6'}, [], []));
    assert.equal(data.validateBridge({name: 'br-new', macaddr: '02:aa:bb:cc:dd:ee'}, [], []).macaddr, '02:AA:BB:CC:DD:EE');
});
test('Numeric settings reject fractional, negative and oversized values', () => {
    for (const mtu of ['abc', '-1', '67', '65536', '1.5']) assert.throws(() => data.validateBridge({name: 'br-new', mtu}, [], []));
    assert.throws(() => data.validatePort({learning: 'on'}));
    assert.throws(() => data.validatePort({multicast_router: '3'}));
    assert.equal(data.validatePort({isolate: '1'}).isolate, '1');
});
test('VLAN access/trunk encoding, duplicate IDs and one PVID per port', () => {
    assert.deepEqual(data.validateVLAN({vlan: '20', local: '1', ports: ['eth1:t', 'eth2:u*']}, sections, bridge).ports, ['eth1:t', 'eth2:u*']);
    for (const id of ['', '0', '4095', '-1', '2.5', 'abc', '10']) assert.throws(() => data.validateVLAN({vlan: id, local: '1', ports: []}, sections, bridge));
    for (const ports of [['eth1:u*'], ['eth0:t'], ['eth2:t', 'eth2:u'], ['eth2:tu'], ['eth2:evil']]) assert.throws(() => data.validateVLAN({vlan: '20', local: '1', ports}, sections, bridge));
    assert.throws(() => data.validateVLAN({vlan: '20', local: '1', ports: []}, sections, bridge, vlan));
    assert.equal(data.validateVLAN({vlan: '10', local: '0', ports: []}, sections, bridge, vlan).local, '0');
});
test('Bridge membership rejects loops, multiple owners and direct routed use', () => {
    for (const name of ['br-lan', 'br-lan.10', 'lo']) assert.throws(() => data.validateMembership(name, bridge, sections, {}));
    assert.throws(() => data.validateMembership('eth0', bridge, sections.concat([{'.type': 'interface', '.name': 'wan', device: 'eth0'}]), {}));
    assert.throws(() => data.validateMembership('eth3', bridge, sections, {'br-other': {'bridge-members': ['eth3']}}));
    assert.throws(() => data.validateMembership('eth4', bridge, sections.concat([{'.type': 'device', type: 'bridge', name: 'br-other', ports: ['eth4']}]), {}));
    assert.doesNotThrow(() => data.validateMembership('eth3', bridge, sections, {eth3: {type: 'Network device'}}));
});
test('References include VLAN descendants and implicit VLAN members', () => {
    assert.deepEqual(data.references(sections, 'br-lan', 'br'), ['v10', 'lan']);
    assert.deepEqual(data.ports(sections.concat([{'.type': 'bridge-vlan', device: 'br-lan', ports: ['eth3:t']}]), bridge), ['eth1', 'eth2', 'eth3']);
});
test('Diff preserves unrelated configuration and handles remove/unset', () => {
    const before = structuredClone(sections), after = structuredClone(before);
    after[0].mtu = '1400'; after[0].ports = []; delete after[0].type;
    const ops = data.operations(before, after);
    assert.equal(ops.length, 1); assert.deepEqual(ops[0].values, {ports: [], mtu: '1400', type: ''});
    assert.equal(data.operations(before, before).length, 0);
    assert.equal(data.operations(before, before.slice(1))[0].kind, 'remove');
    assert.deepEqual(before, sections);
});
test('Rates never invent zero for missing data or counter resets', () => {
    const a = {br: {statistics: {rx_bytes: 100, tx_bytes: 40, rx_packets: 10}}}, b = {br: {statistics: {rx_bytes: 200, tx_bytes: 20, rx_packets: 10}}};
    assert.deepEqual(data.rates(a, b, 5).br, {rx_bytes: 20, tx_bytes: null, rx_packets: 0, tx_packets: null});
    assert.equal(data.rates({}, b, 5).br.rx_bytes, null);
    assert.equal(data.rates(a, b, 0).br.rx_bytes, null);
});
test('Telemetry failures remain distinguishable from empty tables', () => {
    const good = {code: 0, output: '[]'};
    assert.equal(data.decode({link: good, fdb: good, vlan: good}).errors.length, 0);
    assert.equal(data.decode({link: good, fdb: {code: 1, output: '[]'}, vlan: {code: 0, output: 'bad'}}).errors.length, 2);
    assert.equal(data.decode({}).errors.length, 3);
});
test('FDB associates actual masters, excludes non-bridge devices and classifies flags', () => {
    const rows = data.hosts({link: [{ifname: 'eth1', master: 'br-lan'}], fdb: [{mac: '00:11:22:33:44:55', dev: 'eth1', state: 'permanent'}, {mac: '00:11:22:33:44:56', dev: 'eth1', master: 'br-lan', state: 'static', vlan: 10}, {mac: '00:11:22:33:44:57', dev: 'eth1'}, {dev: 'eth0', flags: ['self']}]}, {});
    assert.deepEqual(rows.map(r => r.kind), ['Local', 'Static', 'Dynamic']);
    assert.equal(rows[0].bridge, 'br-lan'); assert.equal(rows[1].vlan, 10);
});
test('CSV escapes cells and neutralizes spreadsheet formulas', () => {
    assert.equal(data.csv(['a'], [['=1+1'], ['a,"b'], ['@evil']]), '"a"\r\n"\'=1+1"\r\n"a,""b"\r\n"\'@evil"');
});
test('iproute2 uses ifname for FDB ports, including local self entries', () => {
    const rows = data.hosts({link: [{ifname: 'test-a', master: 'br-test'}], fdb: [
        {mac: '02:11:22:33:44:55', ifname: 'test-a', master: 'br-test', vlan: 20, state: ''},
        {mac: '33:33:00:00:00:01', ifname: 'test-a', flags: ['self'], state: 'permanent'},
        {mac: '33:33:00:00:00:01', ifname: 'peer-a', flags: ['self'], state: 'permanent'}
    ]}, {});
    assert.equal(rows.length, 2); assert.equal(rows[0].port, 'test-a'); assert.equal(rows[1].bridge, 'br-test');
});
console.log(`${checks} Bridge model tests passed.`);
