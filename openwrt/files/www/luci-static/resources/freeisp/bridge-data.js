'use strict';
'require baseclass';

function list(value) { return Array.isArray(value) ? value.slice() : String(value || '').split(/\s+/).filter(Boolean); }
function bridges(sections) { return sections.filter(function(s) { return s['.type'] === 'device' && s.type === 'bridge'; }); }
function vlans(sections, name) { return sections.filter(function(s) { return s['.type'] === 'bridge-vlan' && s.device === name; }); }
function member(value) {
    var parts = String(value).split(':');
    return {name: parts[0], tagged: /t/.test(parts[1] || ''), pvid: /\*/.test(parts[1] || '')};
}
function ports(sections, bridge) {
    return Array.from(new Set(list(bridge.ports).concat(vlans(sections, bridge.name).flatMap(function(v) { return list(v.ports).map(function(p) { return member(p).name; }); })))).sort();
}
function deviceName(name) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/.test(name) || name === 'lo') throw new Error('Use a device name of 1–15 letters, numbers, underscores, dots or hyphens; lo is reserved.');
    return name;
}
function integer(value, min, max, label) {
    if (value !== '' && (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max)) throw new Error(label + ' must be a whole number from ' + min + ' to ' + max + '.');
    return value === '' ? '' : String(Number(value));
}
function flag(value, label) {
    if (['', '0', '1'].indexOf(value) === -1) throw new Error('Invalid ' + label + ' setting.');
    return value;
}
function references(sections, name, skip) {
    return sections.filter(function(s) {
        if (s['.name'] === skip) return false;
        return ['device', 'ifname', 'ports'].some(function(k) {
            return list(s[k]).some(function(p) { var n = member(p).name; return n === name || n.indexOf(name + '.') === 0; });
        });
    }).map(function(s) { return s.name || s['.name']; });
}
function validateBridge(values, sections, liveNames, original) {
    var v = Object.assign({}, values);
    deviceName(v.name);
    if (original && v.name !== original.name) throw new Error('Existing bridge names cannot be changed here.');
    if (sections.some(function(s) { return s['.name'] !== (original || {})['.name'] && (s.name === v.name || (s['.type'] === 'interface' && s.type === 'bridge' && 'br-' + s['.name'] === v.name)); }) || (!original && liveNames.indexOf(v.name) !== -1)) throw new Error('This device name already exists.');
    [['mtu', 68, 65535, 'MTU'], ['priority', 0, 65535, 'Bridge priority'], ['ageing_time', 0, 1000000, 'MAC ageing time'], ['hello_time', 1, 10, 'Hello interval'], ['forward_delay', 2, 30, 'Forward delay'], ['max_age', 6, 40, 'Maximum age'], ['hash_max', 1, 1048576, 'Multicast table size'], ['robustness', 1, 255, 'Multicast robustness'], ['query_interval', 1, 2147483647, 'Query interval'], ['query_response_interval', 1, 2147483647, 'Query response interval'], ['last_member_interval', 1, 2147483647, 'Last member interval']].forEach(function(r) { v[r[0]] = integer(v[r[0]] || '', r[1], r[2], r[3]); });
    ['stp', 'vlan_filtering', 'bridge_empty', 'igmp_snooping', 'multicast_querier'].forEach(function(k) { v[k] = flag(v[k] || '', k); });
    if (v.stp === '1') {
        var hello = Number(v.hello_time || 1), delay = Number(v.forward_delay || 8), age = Number(v.max_age || 10);
        if (age < 2 * (hello + 1) || age > 2 * (delay - 1)) throw new Error('STP requires 2 × (hello + 1) ≤ maximum age ≤ 2 × (forward delay − 1).');
    }
    v.macaddr = (v.macaddr || '').toUpperCase();
    if (v.macaddr && (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(v.macaddr) || (parseInt(v.macaddr.slice(0, 2), 16) & 1) || v.macaddr === '00:00:00:00:00:00')) throw new Error('Enter a nonzero unicast MAC address.');
    v.type = 'bridge';
    return v;
}
function validatePort(values) {
    var v = {};
    ['learning', 'unicast_flood', 'isolate', 'multicast_to_unicast', 'multicast_fast_leave'].forEach(function(k) { v[k] = flag(values[k] || '', k); });
    if (['', '0', '1', '2'].indexOf(values.multicast_router || '') === -1) throw new Error('Invalid multicast router mode.');
    v.multicast_router = values.multicast_router || '';
    return v;
}
function validateMembership(name, bridge, sections, live) {
    deviceName(name);
    if (name === bridge.name || bridges(sections).some(function(b) { return b.name === name; }) || (live[name] || {}).type === 'bridge') throw new Error('A bridge cannot be used as a member port.');
    if (name.indexOf(bridge.name + '.') === 0) throw new Error('A bridge cannot contain its own VLAN device.');
    var owner = bridges(sections).find(function(b) { return b.name !== bridge.name && ports(sections, b).indexOf(name) !== -1; });
    if (owner) throw new Error(name + ' already belongs to ' + owner.name + '.');
    Object.keys(live).forEach(function(n) {
        if (n !== bridge.name && list(live[n]['bridge-members']).indexOf(name) !== -1) throw new Error(name + ' is currently attached to ' + n + '. Apply its removal there first.');
    });
    var refs = sections.filter(function(s) { return s['.type'] === 'interface' && (list(s.device).indexOf(name) !== -1 || list(s.ifname).indexOf(name) !== -1); });
    if (refs.length) throw new Error('This port is used directly by interface ' + refs.map(function(s) { return s['.name']; }).join(', ') + '. Move that interface to the bridge in Interfaces first.');
}
function validateVLAN(values, sections, bridge, original) {
    var id = integer(values.vlan, 1, 4094, 'VLAN ID');
    if (!id) throw new Error('Enter a VLAN ID.');
    var others = vlans(sections, bridge.name).filter(function(s) { return s['.name'] !== (original || {})['.name']; });
    if (others.some(function(s) { return Number(s.vlan) === Number(id); })) throw new Error('This bridge already has VLAN ' + id + '.');
    if (original && original.vlan !== id && references(sections, bridge.name + '.' + original.vlan, original['.name']).length) throw new Error('This VLAN is used by an interface or device. Remove those references before changing its ID.');
    var available = ports(sections, bridge), seen = new Set();
    var entries = list(values.ports).map(function(p) {
        if (!/^[^:]+(?::[ut]?\*?)?$/.test(p)) throw new Error('Invalid VLAN port flags.');
        var m = member(p);
        if (available.indexOf(m.name) === -1) throw new Error(m.name + ' is not a member of this bridge.');
        if (seen.has(m.name)) throw new Error('Duplicate VLAN port ' + m.name + '.');
        seen.add(m.name);
        if (m.pvid && others.some(function(s) { return list(s.ports).some(function(q) { var other = member(q); return other.name === m.name && other.pvid; }); })) throw new Error(m.name + ' already has a primary VLAN. Each port can have only one PVID.');
        return m.name + ':' + (m.tagged ? 't' : 'u') + (m.pvid ? '*' : '');
    });
    if (['0', '1'].indexOf(values.local) === -1) throw new Error('Select whether the router participates in this VLAN.');
    return {device: bridge.name, vlan: id, local: values.local, ports: entries};
}
function operations(before, after) {
    var result = [];
    before.forEach(function(s) { if (!after.some(function(d) { return d['.name'] === s['.name']; })) result.push({kind: 'remove', section: s}); });
    after.forEach(function(s) {
        var old = before.find(function(b) { return b['.name'] === s['.name']; }), values = {};
        Array.from(new Set(Object.keys(s).concat(Object.keys(old || {})))).filter(function(k) { return k[0] !== '.'; }).forEach(function(k) {
            var a = old && old[k], b = s[k];
            if (JSON.stringify(a == null ? '' : a) !== JSON.stringify(b == null ? '' : b)) values[k] = b == null ? '' : b;
        });
        if (!old || Object.keys(values).length) result.push({kind: old ? 'update' : 'add', section: s, values: values});
    });
    return result;
}
function rates(previous, current, seconds) {
    var result = {};
    Object.keys(current).forEach(function(name) {
        var a = (previous[name] || {}).statistics || {}, b = current[name].statistics || {};
        result[name] = {};
        ['rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets'].forEach(function(k) {
            result[name][k] = seconds > 0 && Number.isSafeInteger(a[k]) && Number.isSafeInteger(b[k]) && b[k] >= a[k] ? (b[k] - a[k]) / seconds : null;
        });
    });
    return result;
}
function decode(raw) {
    var result = {link: [], fdb: [], vlan: [], errors: []};
    ['link', 'fdb', 'vlan'].forEach(function(k) {
        try {
            if (!raw[k] || raw[k].code !== 0) throw new Error('unavailable');
            var rows = JSON.parse(raw[k].output);
            if (!Array.isArray(rows)) throw new Error('invalid response');
            result[k] = rows;
        } catch(e) { result.errors.push(k.toUpperCase() + ' data unavailable'); }
    });
    return result;
}
function hosts(snapshot, live) {
    var owners = {};
    Object.keys(live).forEach(function(name) { list(live[name]['bridge-members']).forEach(function(p) { owners[p] = name; }); });
    snapshot.link.forEach(function(p) { if (p.master) owners[p.ifname] = p.master; });
    return snapshot.fdb.filter(function(h) { var name = h.ifname || h.dev; return h.master || owners[name] || (live[name] || {}).type === 'bridge'; }).map(function(h) {
        var name = h.ifname || h.dev;
        var flags = list(h.flags), state = list(h.state);
        return {bridge: h.master || owners[name] || name, mac: h.mac || '', port: name || '', vlan: h.vlan == null ? '' : h.vlan,
            kind: state.indexOf('permanent') !== -1 || flags.indexOf('local') !== -1 ? 'Local' : state.indexOf('static') !== -1 || state.indexOf('noarp') !== -1 ? 'Static' : 'Dynamic',
            flags: flags.concat(state).join(', '), used: h.used == null ? null : h.used, updated: h.updated == null ? null : h.updated};
    });
}
function csv(headers, rows) {
    return [headers].concat(rows).map(function(row) { return row.map(function(v) {
        var s = v == null ? '' : String(v);
        if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }).join(','); }).join('\r\n');
}
return baseclass.extend({list: list, bridges: bridges, vlans: vlans, member: member, ports: ports, references: references, validateBridge: validateBridge, validatePort: validatePort, validateMembership: validateMembership, validateVLAN: validateVLAN, operations: operations, rates: rates, decode: decode, hosts: hosts, csv: csv});
