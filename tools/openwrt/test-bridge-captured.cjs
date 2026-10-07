/* Verify the production parser against output captured from the real backend test. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const data = new Function('baseclass', fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/bridge-data.js', 'utf8'))({extend: v => v});
const dir = process.argv[2] || 'artifacts/tests/bridge-backend';
const snapshot = data.decode(JSON.parse(fs.readFileSync(path.join(dir, 'bridge-helper.json'), 'utf8')));
assert.deepEqual(snapshot.errors, []);
assert(snapshot.link.some(p => p.ifname === 'test-a' && p.isolated === true));
const hosts = data.hosts(snapshot, {'br-test': {type: 'bridge', 'bridge-members': ['test-a', 'test-b']}});
assert(hosts.every(h => h.port && h.bridge === 'br-test'));
assert(hosts.some(h => h.port === 'test-a' && h.kind === 'Dynamic' && h.vlan === 20));
assert(hosts.some(h => h.port === 'test-b' && h.kind === 'Dynamic' && h.vlan === 20));
assert(!hosts.some(h => /^peer-/.test(h.port)));
console.log('PASS production parser: real bridge ports, access/trunk learned MACs, VLAN IDs and isolation');
