const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(project, 'openwrt/files/www/luci-static/resources/freeisp/firewall-runtime.js'), 'utf8');
let commandReply, commandError;
const calls = [];
const runtime = new Function('baseclass', 'fs', source)(
    { extend: value => value },
    { exec: async (...args) => { calls.push(args); if (commandError) throw commandError; return commandReply; } }
);

// libnftables-json v1 shapes: anonymous and named counters, verdicts, nested
// payload matches, comments and an unrelated table which must not leak in.
const nft = { nftables: [
    { metainfo: { json_schema_version: 1 } },
    { table: { family: 'inet', name: 'fw4', handle: 1 } },
    { counter: { family: 'inet', table: 'fw4', name: 'shared', packets: 4, bytes: 320 } },
    { rule: { family: 'inet', table: 'fw4', chain: 'input_lan', handle: 22, comment: '!fw4: Allow SSH', expr: [
        { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 22 } },
        { counter: { packets: 2, bytes: 120 } }, { accept: null }
    ] } },
    { rule: { family: 'inet', table: 'fw4', chain: 'forward', handle: 23, expr: [ { counter: 'shared' }, { jump: { target: 'accept_to_wan' } } ] } },
    { rule: { family: 'inet', table: 'fw4', chain: 'dstnat', handle: 24, expr: [ { counter: { packets: 0, bytes: 0 } }, { dnat: { addr: '192.168.1.2', port: 443 } } ] } },
    { rule: { family: 'inet', table: 'fw4', chain: 'raw_prerouting', handle: 25, expr: [ { notrack: null } ] } },
    { rule: { family: 'ip', table: 'other', chain: 'input', expr: [ { drop: null } ] } }
] };
const rules = runtime.parseNft(JSON.stringify(nft));
assert.equal(rules.length, 4);
assert.deepEqual(rules[0], { chain: 'input_lan', handle: 22, comment: '!fw4: Allow SSH', packets: 2, bytes: 120, expression: 'tcp dport == 22 accept' });
assert.equal(rules[1].expression, 'jump accept_to_wan');
assert.equal(rules[1].bytes, 320);
assert.equal(rules[2].packets, 0);
assert.equal(rules[3].packets, null, 'An absent counter is unknown, not zero traffic');
assert.equal(rules[3].bytes, null);
assert.throws(() => runtime.parseNft('not json'));
assert.throws(() => runtime.parseNft({}));

// conntrack-tools extended format includes both NAT tuples. Accounting may be
// absent on a working kernel; never manufacture zero byte counters in that case.
const conntrack = [
    'ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.1.10 dst=203.0.113.1 sport=52991 dport=443 packets=2 bytes=120 src=203.0.113.1 dst=198.51.100.2 sport=443 dport=60000 packets=3 bytes=180 [ASSURED] mark=0 use=1',
    'ipv6 10 udp 17 25 src=2001:db8::1 dst=2001:db8::53 sport=60555 dport=53 [UNREPLIED] src=2001:db8::53 dst=2001:db8::1 sport=53 dport=60555 mark=0 use=1',
    'icmp 1 29 src=10.0.0.2 dst=10.0.0.1 type=8 code=0 id=400 packets=0 bytes=0 src=10.0.0.1 dst=10.0.0.2 type=0 code=0 id=400 packets=0 bytes=0 mark=0 use=1',
    'ipv4 2 tcp 6 80 TIME_WAIT src=10.0.0.2 dst=203.0.113.1 sport=1111 dport=80 src=203.0.113.1 dst=10.0.0.2 sport=80 dport=1111 mark=0 use=1'
].join('\n');
const connections = runtime.parseConnections(conntrack);
assert.equal(connections.invalid, 0);
assert.equal(connections.rows.length, 4, 'TIME_WAIT is a real tracked state and remains visible');
assert.equal(connections.rows[0].source, '192.168.1.10:52991');
assert.equal(connections.rows[0].replyDestination, '198.51.100.2:60000');
assert.equal(connections.rows[0].state, 'ESTABLISHED');
assert.equal(connections.rows[0].bytes, 300);
assert.equal(connections.rows[0].packets, 5);
assert.equal(connections.rows[1].source, '[2001:db8::1]:60555');
assert.equal(connections.rows[1].state, 'UNREPLIED');
assert.equal(connections.rows[1].bytes, null);
assert.equal(connections.rows[2].source, '10.0.0.2');
assert.equal(connections.rows[2].bytes, 0);
assert.equal(runtime.parseConnections('garbage\n').invalid, 1);
assert.equal(runtime.parseConnections('tcp 6 10 ESTABLISHED mark=0').invalid, 1);
assert.deepEqual(runtime.parseConnections(''), { rows: [], invalid: 0 });

const catalogue = `config helper
 option name 'ftp'
 option description 'FTP passive connection tracking'
 option module 'nf_conntrack_ftp'
 option family 'any'
 option proto 'tcp'
 option port '21'
config helper
 option name 'sip'
 option description 'SIP VoIP connection tracking'
 option module 'nf_conntrack_sip'
 option proto 'udp'
 option port '5060'
config helper
 option name 'tftp'
 option module 'nf_conntrack_tftp'
 option port '69'
`;
const helpers = runtime.parseHelpers(catalogue, 'nf_conntrack_ftp 4096 0 - Live 0xffffffff\n', '/lib/modules/6.12.0/nf_conntrack_sip.ko.zst\n');
assert.equal(helpers.length, 3);
assert.equal(helpers[0].loaded, true);
assert.equal(helpers[0].available, true);
assert.equal(helpers[1].loaded, false);
assert.equal(helpers[1].available, true);
assert.equal(helpers[2].available, false);

const snapshot = {
    version: 1,
    nft: { code: 0, stdout: JSON.stringify(nft) },
    connections: { code: 0, stdout: conntrack, truncated: false },
    helpers: { code: 0, stdout: catalogue },
    modules: '', installedModules: ''
};
assert.equal(runtime.parseSnapshot(snapshot).errors.length, 0);
const missingNft = runtime.parseSnapshot({ ...snapshot, nft: { code: 1, stderr: 'No such file or directory' } });
assert.deepEqual(missingNft.rules, []);
assert.equal(missingNft.connections.length, 4, 'One failed source must not hide the others');
assert.match(missingNft.errors[0], /Live firewall rules.*No such file/);
assert.match(runtime.parseSnapshot({ ...snapshot, nft: { code: 0, stdout: '' } }).errors[0], /Live firewall rules/);
assert.match(runtime.parseSnapshot({ ...snapshot, connections: { code: 1, stderr: 'Connection tracking is unavailable' } }).errors[0], /unavailable/);
assert.match(runtime.parseSnapshot({ ...snapshot, connections: { code: 0, stdout: conntrack, truncated: true, limit: 5000 } }).errors[0], /first 5000/);
assert.throws(() => runtime.parseSnapshot({ error: 'missing JSON support' }), /missing JSON/);

(async () => {
    commandReply = { code: 0, stdout: JSON.stringify(snapshot) };
    const live = await runtime.load();
    assert.equal(live.rules.length, 4);
    assert.equal(live.connections.length, 4);
    assert.deepEqual(calls[0], ['/usr/bin/freeisp-firewall-status', []], 'The helper never accepts configurable commands or arguments');
    commandReply = { code: 1, stderr: 'Permission denied' };
    assert.match((await runtime.load()).errors[0], /Permission denied/);
    commandReply = { code: 0, stdout: '{bad json' };
    assert.equal((await runtime.load()).errors.length, 1);
    commandError = new Error('RPC access denied');
    assert.match((await runtime.load()).errors[0], /RPC access denied/);
    const helper = fs.readFileSync(path.join(project, 'openwrt/files/usr/bin/freeisp-firewall-status'), 'utf8');
    assert.match(helper, /"\$#" -ne 0/);
    assert.match(helper, /nft -j list table inet fw4/);
    assert.doesNotMatch(helper, /\bnft\s+(add|delete|flush|reset|replace)\b/);
    assert.doesNotMatch(helper, /\bconntrack\s+(-D|-F|--delete|--flush)\b/);
    console.log('Firewall runtime: nft rules, real/unknown counters, IPv4/IPv6 NAT tuples, connection states, helper capabilities, source errors and read-only RPC contract passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
