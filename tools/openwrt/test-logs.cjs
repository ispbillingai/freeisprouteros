const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = 'openwrt/files/';
const data = new Function('baseclass', fs.readFileSync(root + 'www/luci-static/resources/freeisp/log-data.js', 'utf8'))({extend: x => x});
const entries = [
    {id: 0, time: 1791360000123, priority: 30, msg: 'dnsmasq-dhcp[51]: DHCPACK(br-lan) 10.77.0.100 client'},
    {id: 1, time: 1791360001123, priority: 4, msg: '[ 12.4] eth0: link down'},
    {id: 2, time: 1791360002123, priority: 35, msg: 'dropbear[99]: Failed login'},
    {id: 3, time: 1791360003123, priority: 191, msg: '<img src=x onerror=alert(1)> & "event"'}
];
const rows = data.parse({log: entries});
assert.equal(rows[0].id, '0');
assert.equal(rows[0].time, new Date(entries[0].time).toISOString().replace('T', ' ').replace('Z', ''));
assert.equal(rows[0].topics, 'daemon, info, dnsmasq-dhcp');
assert.equal(rows[1].facility, 'kern'); assert.equal(rows[1].severity, 'warn');
assert.equal(rows[2].severity, 'err'); assert.equal(rows[3].topics, 'local7, debug');
assert.equal(data.filter(rows, ' dhcpack ', '', '').length, 1);
assert.equal(data.filter(rows, '[', '', '').length, 3, 'Search must be literal, not a regex');
assert.equal(data.filter(rows, '', 'warn', 'kern').length, 1);
assert.equal(data.filter(rows, '', 'info', 'kern').length, 0);
assert.equal(data.filter(rows, 'missing', '', '').length, 0);
assert.match(data.text(rows), /<img src=x onerror=alert\(1\)>/);
assert.deepEqual(data.parse({log: []}), []);
for (const invalid of [null, {}, {log: null}, {log: 'bad'}, {log: [null]}, {log: [{msg: 42}]}]) assert.throws(() => data.parse(invalid));
const unknown = data.parse({log: [{priority: -1, time: 'bad', msg: 'unknown'}]})[0];
assert.equal(unknown.time, 'Unknown'); assert.equal(unknown.severity, 'unknown');
const acl = JSON.parse(fs.readFileSync(root + 'usr/share/rpcd/acl.d/luci-app-freeisp-log.json'))['luci-app-freeisp-log'];
assert.deepEqual(acl.read, {ubus: {log: ['read']}}); assert.equal(acl.write, undefined);
const menu = JSON.parse(fs.readFileSync(root + 'usr/share/luci/menu.d/luci-app-freeisp-log.json'))['admin/status/freeisp_log'];
assert.equal(menu.action.path, 'freeisp/log'); assert.deepEqual(menu.depends.acl, ['luci-app-freeisp-log']);
assert.match(fs.readFileSync(root + 'www/luci-static/freeisp/navigation.js', 'utf8'), /\['Log', 'status\/freeisp_log'\]/);
console.log('Logs data checks passed: real logd schema, timestamps, priorities, literal filters, malformed replies, empty buffer, read-only ACL and menu.');
