const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'openwrt/files/';
const data = new Function('baseclass', fs.readFileSync(base + 'www/luci-static/resources/freeisp/queues-data.js', 'utf8'))({extend: v => v});
for (const [input, expected] of [['0', 'Shaping off'], ['10', '10 kbps'], ['10000', '10 Mbps'], ['12501', '12.501 Mbps'], ['1000000', '1 Gbps'], ['0010', '10 kbps'], [0, 'Shaping off']]) assert.equal(data.limit(input), expected);
for (const input of [undefined, null, '', '-1', '1.1', '1e3', '10M', 'NaN', '9007199254740992']) assert.equal(data.limit(input), '—');
const rows = data.queues({
    wan: {'.type': 'queue', interface: 'eth0', enabled: '1', upload: '10000', download: '25000', qdisc: 'cake', script: 'piece_of_cake.qos'},
    backup: {'.type': 'queue', interface: 'eth1', enabled: '0', upload: '0', download: '5000', qdisc: 'custom'},
    incomplete: {'.type': 'queue'}, unrelated: {'.type': 'other'}, invalid: null
});
assert.equal(rows.length, 3);
assert.deepEqual(rows[0], {name: 'wan', enabled: true, device: 'eth0', upload: '10 Mbps', download: '25 Mbps', qdisc: 'cake', script: 'piece_of_cake.qos'});
assert.equal(rows[1].enabled, false); assert.equal(rows[1].upload, 'Shaping off');
assert.equal(rows[2].enabled, false); assert.equal(rows[2].upload, '—');
assert.deepEqual(data.types(rows, [{name: 'cake'}, {name: 'fq_codel'}, {name: 'cake'}]), [
    {name: 'cake', available: true, queues: ['wan']},
    {name: 'custom', available: false, queues: ['backup']},
    {name: 'fq_codel', available: true, queues: []}
]);
assert(data.types(rows, null).every(t => t.available === null));
assert.deepEqual(data.types([], []), []);
const acl = JSON.parse(fs.readFileSync(base + 'usr/share/rpcd/acl.d/luci-app-freeisp.json'))['luci-app-freeisp-queues'];
assert.deepEqual(acl.write.uci, ['sqm'], 'Only SQM may be written');
assert.deepEqual(acl.read.uci, ['sqm']);
assert.deepEqual(Object.keys(acl.write.file), ['/etc/init.d/sqm enable']);
for (const method of ['add', 'set', 'delete', 'apply', 'confirm', 'revert']) assert(acl.write.ubus.uci.includes(method));
const values = {name: 'wan', interface: 'eth0', enabled: '1', upload: '10000', download: '10000', qdisc: 'cake', script: 'piece_of_cake.qos'};
const devices = {eth0: {}, eth1: {}}, inventory = [{name: 'cake'}, {name: 'fq_codel'}], scripts = [{name: 'piece_of_cake.qos'}, {name: 'simple.qos'}];
const valid = (overrides = {}, sections = {}, id) => data.validate({...values, ...overrides}, sections, devices, inventory, scripts, id);
assert.equal(valid({upload: '00010'}).upload, '10');
for (const name of ['', '../bad', 'a;reboot', '1name', 'a'.repeat(33)]) assert.throws(() => valid({name}), /queue name/);
for (const upload of ['', '-1', '1.5', '1e3', '2147483648']) assert.throws(() => valid({upload}), /whole kbit/);
assert.throws(() => valid({upload: '0', download: '0'}), /nonzero/);
assert.throws(() => valid({interface: 'lo'}), /valid network/);
assert.throws(() => valid({interface: 'missing'}), /unavailable/);
assert.throws(() => valid({qdisc: 'unknown'}), /available queue/);
assert.throws(() => valid({script: '../bad.qos'}), /installed/);
assert.throws(() => valid({name: 'exists'}, {exists: {'.type': 'other'}}), /already exists/);
assert.throws(() => valid({}, {other: {'.type': 'queue', enabled: '1', interface: 'eth0'}}), /already uses/);
const initial = {wan: {'.type': 'queue', ...valid(), overhead: '44', qdisc_advanced: '1'}, other: {'.type': 'other', untouched: 'yes'}};
const draft = structuredClone(initial); draft.wan.upload = '20000'; draft.backup = {'.type': 'queue', ...valid({name: 'backup', interface: 'eth1'})};
const ops = data.operations(initial, draft), saved = structuredClone(initial);
assert.deepEqual(ops[0], {kind: 'set', id: 'wan', values: {upload: '20000'}});
data.stage({
    add: (config, type, id) => { assert.equal(config, 'sqm'); saved[id] = {'.type': type}; return id; },
    set: (config, id, key, value) => { assert.equal(config, 'sqm'); saved[id][key] = value; },
    remove: (config, id) => { assert.equal(config, 'sqm'); delete saved[id]; }
}, ops);
assert.deepEqual(saved, draft); assert.equal(saved.wan.overhead, '44');
assert.deepEqual(data.operations(initial, {other: initial.other}), [{kind: 'remove', id: 'wan'}]);
assert.equal(data.runtime('eth0', null).label, 'Unknown');
assert.equal(data.runtime('eth0', []).label, 'No root queue observed');
assert.deepEqual(data.runtime('eth0', [{dev: 'eth0', root: true, kind: 'cake', options: {bandwidth: 1250000}, bytes: 42}]), {label: 'cake · 10 Mbps', bytes: '42'});
console.log('Queues: units, invalid inputs, duplicate devices, installed choices, targeted add/edit/delete, preserved options, runtime status and scoped permissions passed.');
