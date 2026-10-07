'use strict';
'require baseclass';
'require rpc';
'require fs';
'require uci';
'require ui';

var board = rpc.declare({object: 'system', method: 'board', expect: {'': {}}, reject: true});
var info = rpc.declare({object: 'system', method: 'info', expect: {'': {}}, reject: true});
var dump = rpc.declare({object: 'network.interface', method: 'dump', expect: {interface: []}, reject: true});
var devices = rpc.declare({object: 'luci-rpc', method: 'getNetworkDevices', expect: {'': {}}, reject: true});

function create() {
    var locked = false;
    async function config(name, type) { uci.unload(name); await uci.load(name); return uci.sections(name, type); }
    return {
        canWrite: function() { return L.hasViewPermission() && !locked; },
        identity: async function() { return (await board()).hostname; },
        resources: async function() {
            var result = await Promise.all([board(), info()]), b = result[0], s = result[1];
            return {platform: 'FreeISP / OpenWrt', version: (b.release || {}).version, model: b.model, architecture: b.system,
                'uptime-seconds': s.uptime, 'memory-total-bytes': (s.memory || {}).total, 'memory-free-bytes': (s.memory || {}).free,
                'load-average': (s.load || []).map(function(n) { return (n / 65536).toFixed(2); }).join(', ')};
        },
        devices: async function() {
            var result = await Promise.all([devices(), config('network', 'device')]), live = result[0], sections = result[1];
            return Object.keys(live).sort().map(function(name) {
                var d = live[name], section = sections.find(function(s) { return s.name === name; }), type;
                if (d.bridge || d.devtype === 'bridge' || (section && section.type === 'bridge')) type = 'bridge';
                else if (d.devtype === 'vlan' || (section && /^8021[aq]$/.test(section.type))) type = 'vlan';
                else if (d.wireless) type = 'wireless';
                else if (name === 'lo' || Number(d.type) === 772) type = 'loopback';
                else type = Number(d.type) === 1 ? 'ethernet' : 'device';
                return {name: name, type: type, running: Boolean(d.up), mtu: d.mtu, 'mac-address': d.mac};
            });
        },
        bridges: async function() {
            return (await config('network', 'device')).filter(function(s) { return s.type === 'bridge'; }).map(function(s) { return {name: s.name, ports: s.ports || []}; });
        },
        vlans: async function() {
            return (await config('network', 'device')).filter(function(s) { return /^8021[aq]$/.test(s.type); }).map(function(s) { return {name: s.name, interface: s.ifname, 'vlan-id': s.vid, type: s.type}; });
        },
        addresses: async function(ipv6) {
            var rows = [];
            (await dump()).forEach(function(s) {
                var addresses = (s[ipv6 ? 'ipv6-address' : 'ipv4-address'] || []).slice();
                if (ipv6) (s['ipv6-prefix-assignment'] || []).forEach(function(p) { if (p['local-address']) addresses.push(p['local-address']); });
                addresses.forEach(function(a) { rows.push({address: a.address + '/' + a.mask, interface: s.interface, device: s.l3_device || s.device}); });
            });
            return rows;
        },
        dns: async function() { return (await dump()).map(function(s) { return {interface: s.interface, servers: s['dns-server'] || []}; }); },
        execute: async function(action, args) {
            var result = await fs.exec('/usr/bin/freeisp-command-line', [action].concat(args));
            var output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
            if (result.code !== 0) throw new Error((output ? output + '\n' : '') + 'Command exited with status ' + result.code + '.');
            return output || '(no output)';
        },
        applyIdentity: async function(draft) {
            if (!this.canWrite()) throw new Error('Changes are unavailable for this session. Reload after reviewing pending changes.');
            var pending = await uci.changes();
            if (Object.keys(pending).some(function(k) { return pending[k].length; })) throw new Error('OpenWrt already has pending changes. Apply or revert them before /apply.');
            var systems = await config('system', 'system'), section = systems[0];
            if (!section || section.hostname !== draft.original) throw new Error('Router identity changed. Use /discard and read /system identity print before retrying.');
            locked = true;
            try {
                uci.set('system', section['.name'], 'hostname', draft.name);
                await uci.save(); await ui.changes.init(); await ui.changes.apply(true);
            } catch(e) {
                throw new Error('Saving or applying did not finish. Review OpenWrt pending changes and reload before retrying. ' + (e.message || e));
            }
        }
    };
}
return baseclass.extend({create: create});
