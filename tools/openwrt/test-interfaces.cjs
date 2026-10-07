const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = new Function('baseclass', fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/interfaces-data.js', 'utf8'))({extend: value => value});
const clone = value => structuredClone(value);
const bridge = {'.name': 'bridge', '.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth1']};
const vlan = {'.name': 'tag', '.type': 'device', name: 'vlan20', type: '8021q', ifname: 'eth0', vid: '20', mtu: '1500', ingress_qos_mapping: ['0:1']};
const sections = [bridge, vlan, {'.name': 'wan', '.type': 'interface', device: 'eth0', proto: 'dhcp'}, {'.name': 'lan', '.type': 'interface', device: 'br-lan', proto: 'static', ipaddr: '10.77.0.1'}];
const devices = [{name: 'eth0', type: 'ethernet', mtu: 1500}, {name: 'eth1', type: 'ethernet', mtu: 1500}, {name: 'br-lan', type: 'bridge', mtu: 1500}, {name: 'vlan20', type: 'vlan', mtu: 1500}];
const values = {name: 'vlan30', type: '8021q', ifname: 'eth0', vid: '30', mtu: ''};
function valid(overrides = {}, ss = sections, ds = devices, old) { return data.validateVLAN({...values, ...overrides}, ss, ds, old); }
for (const vid of ['1', '4094', '0030']) assert.equal(valid({vid}).vid, String(Number(vid)));
for (const vid of ['', '0', '4095', '-1', '1.5', '1e2', 'abc']) assert.throws(() => valid({vid}), /VLAN ID/);
for (const name of ['lo', '', 'longinterfacename', 'bad name', '<script>', '../eth0']) assert.throws(() => valid({name}), /device name/);
for (const ifname of ['', 'missing', 'vlan30']) assert.throws(() => valid({ifname}), /parent/);
assert.throws(() => valid({type: 'bridge'}), /802/);
assert.throws(() => valid({name: 'eth1'}), /already exists/);
assert.throws(() => valid({vid: '20'}), /already exist/);
assert.equal(valid({type: '8021ad', vid: '20'}).type, '8021ad');
assert.throws(() => valid({}, sections, [...devices, {name: 'eth0.30', type: 'vlan'}]), /already exists as/);
assert.equal(valid({ifname: 'br-lan'}).ifname, 'br-lan');
assert.equal(valid({ifname: 'vlan20'}).ifname, 'vlan20');
assert.throws(() => valid({ifname: 'br-lan'}, [{...bridge, vlan_filtering: '1'}, vlan]), /VLAN filtering/);
assert.throws(() => valid({ifname: 'br-lan'}, [...sections, {'.type': 'bridge-vlan', device: 'br-lan', vlan: '30'}]), /VLAN filtering/);
assert.throws(() => valid({mtu: '1501'}), /parent MTU/);
assert.throws(() => valid({mtu: '1500'}, [...sections, {'.type': 'device', name: 'eth0', mtu: '1400'}]), /parent MTU/);
for (const mtu of ['0', '67', '65536', '1.5']) assert.throws(() => valid({mtu}), /MTU/);
assert.deepEqual(data.references([...sections, {'.name': 'guest', '.type': 'interface', device: 'vlan20'}, {'.name': 'nested', '.type': 'device', ifname: 'vlan20.50'}, {'.name': 'brguest', '.type': 'device', ports: ['vlan20:t', 'eth1']}], 'vlan20', 'tag'), ['guest', 'nested', 'brguest']);
const used = [...sections, {'.name': 'guest', '.type': 'interface', device: 'vlan20'}];
assert.throws(() => valid({name: 'renamed', vid: '20'}, used, devices, vlan), /in use/);
assert.equal(valid({...vlan, vid: '21'}, used, devices, vlan).vid, '21');
const child = {'.name': 'child', '.type': 'device', name: 'child', type: '8021q', ifname: 'vlan20', vid: '10'};
assert.throws(() => valid({...vlan, ifname: 'child'}, [...sections, child], devices, vlan), /loop/);
assert.equal(data.deviceType('lo', {type: 772}, sections), 'loopback');
assert.equal(data.deviceType('eth0', {type: 1}, sections), 'ethernet');
assert.equal(data.deviceType('wlan0', {type: 1, wireless: true}, sections), 'wireless');
assert.equal(data.deviceType('br-guest', {type: 1, bridge: true}, sections), 'bridge');
assert.equal(data.deviceType('lan1', {type: 1, devtype: 'dsa'}, sections), 'ethernet');
assert.equal(data.deviceType('vlan20', {type: 1}, sections), 'vlan');
assert.equal(data.deviceType('tun0', {type: 65534}, sections), 'device');
assert.deepEqual(data.validateEthernet({mtu: '', macaddr: ''}), {mtu: '1500', macaddr: ''});
assert.equal(data.validateEthernet({mtu: '1500', macaddr: '02:ab:cd:00:00:01'}).macaddr, '02:AB:CD:00:00:01');
for (const macaddr of ['01:00:00:00:00:01', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', 'invalid']) assert.throws(() => data.validateEthernet({mtu: '', macaddr}), /unicast/);

// Simulate UCI writes and prove only the targeted device changes; preserve all
// interface addressing, bridge membership and unrelated VLAN options.
const draft = clone(sections);
draft.find(s => s['.name'] === 'tag').vid = '21';
draft.find(s => s['.name'] === 'tag').mtu = '';
draft.push({'.name': 'draft1', '.type': 'device', ...values});
const operations = data.operations(sections, draft);
data.validateDraft(sections, draft, devices);
assert.throws(() => data.validateDraft(sections, [...clone(sections), {'.name': 'port', '.type': 'device', name: 'eth0', mtu: '1400'}], devices), /parent.*MTU/);
assert.equal(operations.length, 2);
assert.deepEqual(operations[0].values, {vid: '21', mtu: ''});
const saved = clone(sections), calls = [];
const uci = {
    set(config, sid, key, value) { calls.push(config); const s = saved.find(s => s['.name'] === sid); if (value === '') delete s[key]; else s[key] = value; },
    add(config, type) { calls.push(config); saved.push({'.name': 'saved1', '.type': type}); return 'saved1'; },
    remove(config, sid) { calls.push(config); saved.splice(saved.findIndex(s => s['.name'] === sid), 1); }
};
data.stage(uci, operations);
assert(calls.every(c => c === 'network'));
assert.deepEqual(saved.filter(s => s['.type'] === 'interface'), sections.filter(s => s['.type'] === 'interface'));
assert.deepEqual(saved[0], bridge);
assert.deepEqual(saved[1].ingress_qos_mapping, ['0:1']);
assert.equal(saved[1].mtu, undefined);
assert.deepEqual(saved.at(-1), {'.name': 'saved1', '.type': 'device', name: 'vlan30', type: '8021q', ifname: 'eth0', vid: '30'});
data.stage(uci, data.operations(saved, saved.filter(s => s['.name'] !== 'saved1')));
assert(!saved.some(s => s.name === 'vlan30'));
assert.deepEqual(data.operations(sections, clone(sections)), []);
assert.equal(data.rate(100, 1100, 1), '8.0 kbps');
assert.equal(data.rate(100, 125100, 1), '1.0 Mbps');
assert.equal(data.rate(100, 100, 5), '0 bps');
assert.equal(data.rate(100, 1, 5), '—');
assert.equal(data.rate(undefined, 100, 5), '—');
console.log('Interfaces: VLAN validation, parent cycles, references, Ethernet, targeted UCI add/edit/delete and traffic rates passed.');
