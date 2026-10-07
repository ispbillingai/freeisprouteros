/* Runs the actual parser and transport adapter with representative ubus replies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const base = 'openwrt/files/www/luci-static/resources/';
const engine = new Function('baseclass', fs.readFileSync(base + 'freeisp/command-line.js', 'utf8'))({extend: v => v});
const backendSource = fs.readFileSync(base + 'freeisp/command-line-backend.js', 'utf8');
function fixture() {
    const f = {writes: [], execs: [], pending: {}, readonly: false, failSave: false, failApply: false, offline: false,
        system: [{'.name': 'sys', '.type': 'system', hostname: 'FreeISP', timezone: 'UTC'}],
        network: [{'.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth1']}, {'.type': 'device', name: 'vlan20', type: '8021q', ifname: 'eth0', vid: '20'}]};
    const rpc = {declare: spec => async () => {
        assert.equal(spec.reject, true);
        if (f.offline) throw Error('RPC unavailable');
        if (spec.method === 'board') return {hostname: f.system[0].hostname, model: 'Test VM', release: {version: '25.12.5'}, system: 'x86_64'};
        if (spec.method === 'info') return {uptime: 3600, load: [65536, 32768, 0], memory: {total: 1024, free: 512}};
        if (spec.method === 'getNetworkDevices') return {
            eth0: {type: 1, up: true, flags: {up: true}, mac: '00:11:22:33:44:55', mtu: 1500},
            eth1: {type: 1, up: false, flags: {up: true}, mtu: 1500},
            'br-lan': {type: 1, devtype: 'bridge', up: true}, vlan20: {type: 1, devtype: 'vlan', up: true},
            lo: {type: 772, up: true}, wlan0: {type: 1, wireless: true, up: true}};
        if (spec.method === 'dump') return [{interface: 'lan', device: 'br-lan', 'ipv4-address': [{address: '10.77.0.1', mask: 24}],
            'ipv6-address': [{address: 'fe80::1', mask: 64}], 'ipv6-prefix-assignment': [{'local-address': {address: 'fd00::1', mask: 64}}], 'dns-server': ['1.1.1.1']}];
        throw Error('Unexpected RPC: ' + spec.method);
    }};
    const uci = {unload() {}, async load() {}, sections: name => structuredClone(f[name]), changes: async () => f.pending,
        set(...args) { f.writes.push(['set', ...args]); },
        async save() { f.writes.push(['save']); if (f.failSave) throw Error('save failed'); }};
    const ui = {changes: {init: async () => f.writes.push(['init']), apply: async rollback => { f.writes.push(['apply', rollback]); if (f.failApply) throw Error('apply failed'); }}};
    const filesystem = {exec: async (cmd, args) => { f.execs.push([cmd, args]); return f.execResult || {code: 0, stdout: 'live diagnostic output'}; }};
    f.backend = new Function('baseclass', 'rpc', 'fs', 'uci', 'ui', 'L', backendSource)({extend: v => v}, rpc, filesystem, uci, ui, {hasViewPermission: () => !f.readonly}).create();
    f.cli = engine.create(f.backend);
    return f;
}
(async () => {
    let f = fixture(), cli = f.cli;
    assert.deepEqual(engine.tokenize('set name="branch-one"'), ['set', 'name=branch-one']);
    assert.throws(() => engine.tokenize('set name="open'), /Unfinished/);
    assert.throws(() => engine.tokenize('a\nb'), /one command/);
    assert.throws(() => engine.tokenize('x'.repeat(2049)), /2048/);
    assert.match(await cli.run('?'), /interface/);
    await cli.run('/ip/address'); assert.equal(cli.path(), '/ip/address');
    assert.match(await cli.run('pr'), /10\.77\.0\.1\/24/);
    await cli.run('..'); assert.equal(cli.path(), '/ip');
    assert.match(await cli.run('address print detail where interface=lan'), /device: br-lan/);
    assert.match(await cli.run('address print where interface=missing'), /no entries/);
    await cli.run('/'); assert.equal(cli.path(), '/');
    await assert.rejects(cli.run('i'), /Ambiguous/);
    await assert.rejects(cli.run('/ip address print where unsupported=x'), /Expected/);
    await assert.rejects(cli.run('/system reboot'), /Unknown/);
    await assert.rejects(cli.run('/interface print; reboot'), /Unknown/);
    assert.match(await cli.run('/sys res pr'), /load-average: 1.00, 0.50, 0.00/);
    assert.match(await cli.run('/interface print'), /00:11:22:33:44:55/);
    assert.match(await cli.run('/interface print detail where name=eth1'), /running: false/);
    assert(!/wlan0|br-lan|vlan20/.test(await cli.run('/interface ethernet print')));
    assert.match(await cli.run('/interface bridge print'), /eth1/);
    assert.match(await cli.run('/interface vlan print'), /vlan20/);
    assert.match(await cli.run('/ipv6 address print'), /fd00::1\/64/);
    assert.match(await cli.run('/ip dns print'), /1.1.1.1/);
    await cli.run('/ip route print'); await cli.run('/ipv6 route print'); await cli.run('/log print');
    await cli.run('ping 1.1.1.1 count=2');
    assert.deepEqual(f.execs, ['routes4', 'routes6', 'log', 'ping'].map(action => ['/usr/bin/freeisp-command-line', action === 'ping' ? [action, '1.1.1.1', '2'] : [action]]));
    for (const line of ['ping address=$(id)', 'ping address=-f', 'ping address=x;id', 'ping address=x count=0', 'ping x count=6', 'ping x count=1 count=2', 'ping x extra=1']) await assert.rejects(cli.run(line));
    assert.equal(f.execs.length, 4, 'Invalid input must not reach RPC');
    f.execResult = {code: 1, stdout: '100% packet loss', stderr: 'unreachable'};
    await assert.rejects(cli.run('ping 1.1.1.1'), /100% packet loss[\s\S]*status 1/);
    f.offline = true; await assert.rejects(cli.run('/system resource print'), /RPC unavailable/); f.offline = false;
    assert.equal(cli.complete('/sys').line, '/system ');
    assert.equal(cli.complete('/system/res').line, '/system/resource ');
    assert.equal(cli.complete('/system resource pr').line, '/system resource print ');
    assert.deepEqual(cli.complete('/i').choices.sort(), ['interface', 'ip', 'ipv6']);
    await cli.run('/system'); assert.equal(cli.complete('iden').line, 'identity ');
    assert.match(await cli.run('identity ?'), /set/);
    assert.match(await cli.run('identity set ?'), /name=FreeISP/);
    assert.deepEqual(await cli.run('clear'), {clear: true});
    await cli.run('identity set name="Branch-1"'); assert.equal(f.writes.length, 0);
    assert.match(await cli.run('/pending'), /FreeISP -> Branch-1/);
    assert.match(await cli.run('identity print'), /pending-name: Branch-1/);
    for (const name of ['-invalid', 'invalid-', 'bad_name', 'a'.repeat(64), '']) await assert.rejects(cli.run('identity set name=' + name));
    await cli.run('/discard'); assert.equal(cli.hasDraft(), false);
    await cli.run('identity set name=Branch-2'); await cli.run('/apply');
    assert.deepEqual(f.writes, [['set', 'system', 'sys', 'hostname', 'Branch-2'], ['save'], ['init'], ['apply', true]]);
    assert.equal(cli.hasDraft(), false); assert.equal(f.backend.canWrite(), false);
    f = fixture(); f.readonly = true;
    assert.match(await f.cli.run('/interface print'), /eth0/);
    await assert.rejects(f.cli.run('/system identity set name=New'), /read-only/);
    await assert.rejects(f.cli.run('/apply'), /read-only/); assert.equal(f.writes.length, 0);
    for (const mode of ['pending', 'stale', 'save', 'apply']) {
        f = fixture(); await f.cli.run('/system identity set name=New');
        if (mode === 'pending') f.pending = {network: [['set', 'lan', 'ipaddr', '10.1.1.1']]};
        if (mode === 'stale') f.system[0].hostname = 'ChangedElsewhere';
        if (mode === 'save') f.failSave = true;
        if (mode === 'apply') f.failApply = true;
        await assert.rejects(f.cli.run('/apply'), /pending|changed|did not finish/);
        assert.equal(f.cli.hasDraft(), true);
        if (['pending', 'stale'].includes(mode)) assert.deepEqual(f.writes, []);
        else { assert.equal(f.backend.canWrite(), false); await assert.rejects(f.cli.run('/apply')); }
    }
    const acl = JSON.parse(fs.readFileSync('openwrt/files/usr/share/rpcd/acl.d/luci-app-freeisp.json'))['luci-app-freeisp-command-line'];
    assert.deepEqual(acl.read.file, {'/usr/bin/freeisp-command-line': ['exec']});
    assert.deepEqual(acl.write.uci, ['system']);
    const menu = JSON.parse(fs.readFileSync('openwrt/files/usr/share/luci/menu.d/luci-app-freeisp.json'))['admin/system/freeisp_command_line'];
    assert.equal(menu.title, 'Command Line');
    assert.equal(menu.action.path, 'freeisp/command-line');
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
    const wrapper = 'openwrt/files/usr/bin/freeisp-command-line';
    const syntax = spawnSync(shell, ['-n', wrapper], {encoding: 'utf8'}); assert.equal(syntax.status, 0, syntax.stderr);
    for (const args of [[], ['unknown'], ['routes4', 'extra'], ['log', 'extra'], ['ping', '-f', '1'], ['ping', 'x;id', '1'], ['ping', '$(id)', '1'], ['ping', 'host', '6'], ['ping', 'host', '1', 'extra'], ['ping', 'host\nname', '1']]) {
        const result = spawnSync(shell, [wrapper, ...args], {encoding: 'utf8'});
        assert.equal(result.status, 2, 'Server must reject ' + JSON.stringify(args) + ': ' + result.stderr);
    }
    console.log('Command Line passed: hierarchy, completion, live data mapping, diagnostics, validation, server rejection, ACLs, draft/apply/rollback, concurrency and failure handling.');
})().catch(e => { console.error(e); process.exitCode = 1; });
