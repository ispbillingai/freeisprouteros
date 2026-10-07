'use strict';
'require baseclass';

// UCI semantics follow firewall4's parse_rule(), parse_redirect(), parse_nat()
// and parse_ipset() in root/usr/share/ucode/fw4.uc. No shell commands are built.
var tabs = ['Filter Rules', 'NAT', 'Mangle', 'Raw', 'Service Ports', 'Connections', 'Address Lists', 'Layer7 Protocols'];
function list(value) { return (Array.isArray(value) ? value : [value]).reduce(function(out, item) { return out.concat(String(item == null ? '' : item).trim().split(/[\s,]+/).filter(Boolean)); }, []); }
function string(value) { return String(value == null ? '' : value).trim(); }
function own(section) { return /^(rule|redirect|nat|ipset)$/.test(section['.type']); }
function equivalent(a, b) { return JSON.stringify(a == null || a === '' ? '' : a) === JSON.stringify(b == null || b === '' ? '' : b); }
function tabFor(s) {
    if (s['.type'] === 'ipset') return 'Address Lists';
    if (/^(redirect|nat)$/.test(s['.type'])) return 'NAT';
    if (s['.type'] !== 'rule') return null;
    return {MARK: 'Mangle', DSCP: 'Mangle', NOTRACK: 'Raw', HELPER: 'Service Ports'}[string(s.target).toUpperCase()] || 'Filter Rules';
}
function kindFor(s) { return s['.type'] === 'ipset' ? 'ipset' : s['.type'] === 'redirect' ? 'dnat' : s['.type'] === 'nat' ? 'snat' : {Mangle: 'mangle', Raw: 'raw', 'Service Ports': 'helper'}[tabFor(s)] || 'filter'; }
function ipFamily(value) {
    var parts = value.split('/'), ip = parts[0], family = 0;
    function v4(v) { var a = v.split('.'); return a.length === 4 && a.every(function(n) { return /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255; }); }
    if (v4(ip)) family = 4;
    else if (ip.indexOf(':') !== -1 && /^[0-9a-f:.]+$/i.test(ip)) {
        var tail = ip.split(':').pop(), input = ip;
        if (tail.indexOf('.') !== -1) { if (!v4(tail)) return 0; input = ip.slice(0, -tail.length) + '0:0'; }
        var halves = input.split('::');
        if (halves.length > 2) return 0;
        var groups = halves.reduce(function(a, h) { return a.concat(h ? h.split(':') : []); }, []);
        if (!groups.every(function(h) { return /^[0-9a-f]{1,4}$/i.test(h); })) return 0;
        if (halves.length === 2 ? groups.length < 8 : groups.length === 8) family = 6;
    }
    if (!family || parts.length > 2 || parts.length === 2 && (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128))) return 0;
    return family;
}
function addresses(value, label, family, multiple, hostOnly) {
    var items = list(value);
    if (!multiple && items.length > 1) throw new Error(label + ' accepts one address or subnet.');
    items.forEach(function(ip) {
        var f = ipFamily(ip);
        if (!f || hostOnly && ip.indexOf('/') !== -1) throw new Error(label + ': enter a valid literal IP' + (hostOnly ? ' address.' : ' address or CIDR subnet.'));
        if (family !== 'any' && family !== 'ipv' + f) throw new Error(label + ' does not match the selected address family.');
    });
    return multiple ? items : items[0] || '';
}
function ports(value, label, multiple) {
    var items = list(value).map(function(port) {
        var m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(port);
        if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535 || m[2] && (Number(m[2]) < Number(m[1]) || Number(m[2]) > 65535))
            throw new Error(label + ': use ports from 1 to 65535 or ascending ranges, such as 80 or 8000-8080.');
        return String(Number(m[1])) + (m[2] ? '-' + Number(m[2]) : '');
    });
    if (!multiple && items.length > 1) throw new Error(label + ' accepts one port or one range for NAT. Create separate entries for separate ports.');
    return multiple ? items : items[0] || '';
}
function setName(value) { return string(value).replace(/^!\s*/, '').split(/[\s,]+/)[0]; }
function dependencies(sections, name, except) { return sections.filter(function(s) { return s['.name'] !== except && setName(s.ipset) === name; }).map(function(s) { return s.name || s['.name']; }); }
function sameFamily(v, sections) {
    var constraints = [], labels = [];
    function add(f, label) { if (f === 'ipv4' || f === 'ipv6') { constraints.push(f); labels.push(label); } }
    add(v.family, 'address family');
    ['src_ip', 'dest_ip', 'src_dip', 'snat_ip'].forEach(function(key) {
        var families = list(v[key]).map(function(ip) { return ipFamily(ip); }).filter(Boolean);
        if (families.length && families.every(function(f) { return f === families[0]; })) add('ipv' + families[0], key);
    });
    ['src', 'dest'].forEach(function(key) { var zone = sections.filter(function(s) { return s['.type'] === 'zone' && s.name === v[key]; })[0]; if (zone) add(zone.family === '4' ? 'ipv4' : zone.family === '6' ? 'ipv6' : zone.family, key + ' zone'); });
    var ipset = sections.filter(function(s) { return s['.type'] === 'ipset' && s.name === setName(v.ipset); })[0];
    if (ipset) add(ipset.family || 'ipv4', 'address list');
    if (list(v.proto).length === 1 && /^(ipv6-icmp|icmpv6|58)$/.test(list(v.proto)[0])) add('ipv6', 'ICMPv6');
    if (constraints.some(function(f) { return f !== constraints[0]; })) throw new Error('Conflicting IPv4 / IPv6 restrictions in ' + labels.join(', ') + '.');
    if (constraints.length) ['src_ip', 'dest_ip', 'src_dip', 'snat_ip'].forEach(function(key) {
        if (list(v[key]).some(function(ip) { var f = ipFamily(ip); return f && 'ipv' + f !== constraints[0]; })) throw new Error('Address family restrictions would ignore an address in ' + key + '. Choose matching addresses or separate IPv4 and IPv6 rules.');
    });
}
function validate(values, kind, sections, original) {
    sections = sections || [];
    if (!/^(filter|dnat|snat|mangle|raw|helper|ipset)$/.test(kind)) throw new Error('Unknown firewall entry type.');
    var v = {name: string(values.name), family: string(values.family) || (kind === 'ipset' ? 'ipv4' : 'any')};
    if (v.name.length > 128 || /[\x00-\x1f\x7f]/.test(v.name)) throw new Error('Name must be at most 128 characters and contain no control characters.');
    if (!/^(any|ipv4|ipv6)$/.test(v.family)) throw new Error('Choose IPv4, IPv6 or both address families.');
    if (kind === 'ipset') {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(v.name)) throw new Error('Address list name must start with a letter or underscore and contain up to 32 letters, numbers or underscores.');
        if (v.family === 'any') throw new Error('An address list must use one address family, IPv4 or IPv6.');
        if (sections.some(function(s) { return s['.type'] === 'ipset' && s.name === v.name && (!original || s['.name'] !== original['.name']); })) throw new Error('An address list with that name already exists.');
        if (original && original.name !== v.name && dependencies(sections, original.name, original['.name']).length) throw new Error('This address list is in use. Remove its rule references before renaming it.');
        v.match = list(values.match);
        if (v.match.length !== 1 || !/^(src|dest|dst)_(ip|net)$/.test(v.match[0])) throw new Error('Choose a single source or destination address match. Manage tuple sets in Advanced settings.');
        v.entry = addresses(values.entry, 'Address list', v.family, true, false);
        // fw4 drops subnet masks for match type "ip". Use "net" for CIDRs.
        if (v.entry.some(function(ip) { return ip.indexOf('/') !== -1; })) v.match[0] = v.match[0].replace(/_ip$/, '_net');
        return v;
    }
    v.enabled = values.enabled == null ? '1' : string(values.enabled);
    if (!/^[01]$/.test(v.enabled)) throw new Error('Choose enabled or disabled.');
    v.target = string(values.target).toUpperCase() || {filter: 'ACCEPT', dnat: 'DNAT', snat: 'SNAT', raw: 'NOTRACK', helper: 'HELPER', mangle: 'MARK'}[kind];
    var allowed = {filter: ['ACCEPT', 'DROP', 'REJECT'], dnat: ['DNAT'], snat: ['SNAT', 'MASQUERADE'], mangle: ['MARK', 'DSCP'], raw: ['NOTRACK'], helper: ['HELPER']}[kind];
    if (allowed.indexOf(v.target) === -1) throw new Error('This action needs Advanced settings; choose a supported action for this tab.');
    Object.keys({snat_ip: 'snat', snat_port: 'snat', src_dip: 'dnat', src_dport: 'dnat', reflection: 'dnat', set_mark: 'mangle', set_dscp: 'mangle', set_helper: 'helper'}).forEach(function(key) {
        var owner = {snat_ip: 'snat', snat_port: 'snat', src_dip: 'dnat', src_dport: 'dnat', reflection: 'dnat', set_mark: 'mangle', set_dscp: 'mangle', set_helper: 'helper'}[key];
        if (owner !== kind && string(values[key])) throw new Error(key + ' is not used by this action. Clear it in Advanced settings.');
    });
    ['src', 'dest'].forEach(function(key) {
        if (key === 'dest' && /^(raw|helper|snat)$/.test(kind)) {
            if (string(values[key]) || original && string(original[key])) throw new Error('This action does not support a destination zone in this editor. Use Advanced settings.');
            return;
        }
        v[key] = string(values[key]);
        if (v[key] && v[key] !== '*' && !sections.some(function(s) { return s['.type'] === 'zone' && s.name === v[key]; })) throw new Error('Unknown ' + key + ' zone: ' + v[key] + '.');
    });
    if (/^(raw|helper|dnat)$/.test(kind) && (!v.src || v.src === '*')) throw new Error('Choose a specific source zone for this action.');
    if (kind === 'snat' && !v.src) throw new Error('Choose an outgoing zone, or Any zone.');
    if (kind === 'filter' && !v.src && !v.dest) throw new Error('Choose a source or destination zone to define the traffic direction.');
    v.proto = list(values.proto || 'all').map(function(p) { return p.toLowerCase(); });
    if (v.proto.length === 1 && v.proto[0] === 'tcpudp') v.proto = ['tcp', 'udp'];
    if (!v.proto.length || v.proto.some(function(p) { return ['all', 'tcp', 'udp', 'icmp', 'ipv6-icmp', 'icmpv6', 'esp', 'ah', 'gre', 'igmp', 'sctp', 'dccp', 'udplite'].indexOf(p) === -1 && !/^\d{1,3}$/.test(p) || /^\d+$/.test(p) && Number(p) > 255; })) throw new Error('Choose a supported IP protocol.');
    v.proto = v.proto.map(function(p) { return {'6': 'tcp', '17': 'udp', '58': 'ipv6-icmp', '1': 'icmp', icmpv6: 'ipv6-icmp'}[p] || p; });
    if (v.proto.indexOf('all') !== -1 && v.proto.length !== 1) throw new Error('Any protocol cannot be combined with other protocols.');
    var nat = kind === 'dnat' || kind === 'snat';
    v.src_ip = addresses(values.src_ip, 'Source address', v.family, !nat, false);
    v.dest_ip = addresses(values.dest_ip, kind === 'dnat' ? 'Internal address' : 'Destination address', v.family, !nat, kind === 'dnat');
    v.src_port = ports(values.src_port, 'Source ports', !nat);
    v.dest_port = ports(values.dest_port, kind === 'dnat' ? 'Internal port' : 'Destination ports', !nat);
    if (kind === 'dnat') {
        if (!v.dest_ip) throw new Error('Enter the internal destination IP address.');
        v.src_dip = addresses(values.src_dip, 'External address', v.family, false, false);
        v.src_dport = ports(values.src_dport, 'External ports', false);
        v.reflection = values.reflection == null ? '1' : string(values.reflection);
        if (!/^[01]$/.test(v.reflection)) throw new Error('Choose enabled or disabled NAT loopback.');
    }
    if (kind === 'snat') {
        v.snat_ip = addresses(values.snat_ip, 'Translated address', v.family, false, true);
        v.snat_port = ports(values.snat_port, 'Translated ports', false);
        if (v.target === 'SNAT' && !v.snat_ip && !v.snat_port) throw new Error('Source NAT needs a translated address or port.');
        if (v.target === 'MASQUERADE' && (v.snat_ip || v.snat_port)) throw new Error('Masquerade uses the interface address; clear translated address and ports.');
    }
    var hasPorts = ['src_port', 'dest_port', 'src_dport', 'snat_port'].some(function(k) { return list(v[k]).length; });
    if (hasPorts && v.proto.some(function(p) { return p !== 'tcp' && p !== 'udp'; })) throw new Error('Port matching or translation requires TCP and/or UDP. Choose the protocol explicitly.');
    if (kind === 'filter' || kind === 'mangle') {
        v.ipset = string(values.ipset);
        if (v.ipset && !sections.some(function(s) { return s['.type'] === 'ipset' && s.name === v.ipset && s.enabled !== '0'; })) throw new Error('Choose an existing enabled address list. Advanced set matches need Advanced settings.');
    }
    if (kind === 'mangle') {
        v.set_mark = string(values.set_mark); v.set_dscp = string(values.set_dscp).toUpperCase();
        if (v.target === 'MARK') {
            if (!/^(?:0x[0-9a-f]+|\d+)(?:\/(?:0x[0-9a-f]+|\d+))?$/i.test(v.set_mark) || v.set_mark.split('/').some(function(n) { return Number(n) > 4294967295; })) throw new Error('Packet mark must be a 32-bit decimal or hexadecimal value, optionally followed by /mask.');
            if (v.set_dscp) throw new Error('A packet-mark action cannot also set DSCP.');
            if (original && original.set_xmark) throw new Error('This rule uses set_xmark. Edit its mark in Advanced settings.');
        } else {
            if (!/^(?:[0-9]|[1-5][0-9]|6[0-3]|CS[0-7]|AF[1-4][1-3]|EF|BE|LE)$/.test(v.set_dscp)) throw new Error('DSCP must be 0–63, CS0–CS7, AF11–AF43, EF, BE or LE.');
            if (v.set_mark) throw new Error('A DSCP action cannot also set a packet mark.');
        }
    }
    if (kind === 'helper') {
        v.set_helper = string(values.set_helper);
        if (!/^[a-zA-Z0-9_-]+$/.test(v.set_helper)) throw new Error('Choose an installed connection helper.');
        if (v.proto.some(function(p) { return p !== 'tcp' && p !== 'udp'; })) throw new Error('Connection helpers require an explicit TCP or UDP protocol.');
    }
    sameFamily(Object.assign({}, original || {}, v), sections);
    return v;
}
function operations(before, after) {
    var ops = [], remaining = before.filter(function(s) { return !own(s) || after.some(function(a) { return a['.name'] === s['.name']; }); }).map(function(s) { return s['.name']; });
    before.filter(own).forEach(function(s) { if (!after.some(function(a) { return a['.name'] === s['.name']; })) ops.push({kind: 'remove', section: s}); });
    after.filter(own).forEach(function(s) {
        var old = before.filter(function(b) { return b['.name'] === s['.name']; })[0], values = {};
        if (old && old['.type'] !== s['.type']) throw new Error('Changing a firewall section type is not supported.');
        Object.keys(Object.assign({}, old || {}, s)).filter(function(k) { return k.charAt(0) !== '.'; }).forEach(function(k) { if (!equivalent(s[k], old && old[k])) values[k] = s[k] == null ? '' : s[k]; });
        if (!old || Object.keys(values).length) ops.push({kind: old ? 'set' : 'add', section: s, values: values});
        if (!old) remaining.push(s['.name']);
    });
    var desired = after.map(function(s) { return s['.name']; });
    if (JSON.stringify(remaining) !== JSON.stringify(desired)) ops.push({kind: 'order', order: desired});
    return ops;
}
return baseclass.extend({
    tabs: tabs, list: list, tabFor: tabFor, kindFor: kindFor, ipFamily: ipFamily,
    dependencies: dependencies, references: dependencies, validate: validate, operations: operations,
    validateDraft: function(before, after) {
        before.filter(function(s) { return s['.type'] === 'ipset'; }).forEach(function(s) {
            if (!after.some(function(a) { return a['.type'] === 'ipset' && a.name === s.name; }) && dependencies(after, s.name).length) throw new Error('Address list ' + s.name + ' is still referenced by ' + dependencies(after, s.name).join(', ') + '.');
        });
        after.filter(own).forEach(function(s) {
            var old = before.filter(function(b) { return b['.name'] === s['.name']; })[0];
            if (!old || operations([old], [s]).length) validate(s, kindFor(s), after, old || {'.name': s['.name']});
            if (s.ipset) {
                var a = after.filter(function(t) { return t['.type'] === 'ipset' && t.name === setName(s.ipset); })[0];
                var b = before.filter(function(t) { return t['.type'] === 'ipset' && t.name === setName(s.ipset); })[0];
                if (a && b && !equivalent(a, b)) sameFamily(s, after);
            }
        });
    },
    stage: function(uci, ops) {
        var ids = {};
        ops.forEach(function(op) {
            if (op.kind === 'order') {
                // LuCI move(config, sid, target, after) moves before target;
                // null target appends. Work backwards to preserve total order.
                var next = null;
                op.order.slice().reverse().forEach(function(id) { var sid = ids[id] || id; if (uci.move('firewall', sid, next, false) === false) throw new Error('Could not save firewall rule order.'); next = sid; });
                return;
            }
            if (!own(op.section)) throw new Error('Only firewall rules, NAT entries and address lists can be staged here.');
            var sid = op.section['.name'];
            if (op.kind === 'remove') { uci.remove('firewall', sid); return; }
            if (op.kind === 'add') sid = ids[sid] = uci.add('firewall', op.section['.type']);
            else if (op.kind !== 'set') throw new Error('Unknown firewall operation.');
            Object.keys(op.values).forEach(function(k) { if (k.charAt(0) !== '.') uci.set('firewall', sid, k, Array.isArray(op.values[k]) && !op.values[k].length ? '' : op.values[k]); });
        });
        return ids;
    }
});
