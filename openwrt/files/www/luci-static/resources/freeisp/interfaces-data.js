'use strict';
'require baseclass';

function list(value) { return Array.isArray(value) ? value : String(value || '').split(/\s+/).filter(Boolean); }
function isVLAN(s) { return s['.type'] === 'device' && /^(8021q|8021ad)$/.test(s.type); }
function references(sections, name, except) {
    return sections.filter(function(s) {
        return s['.name'] !== except && ['device', 'ifname', 'ports'].some(function(key) {
            return list(s[key]).some(function(v) {
                v = v.replace(/:[ut*]+$/, '');
                return v === name || v.indexOf(name + '.') === 0;
            });
        });
    }).map(function(s) { return s.name || s['.name']; });
}
function integer(value, min, max, label) {
    if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max)
        throw new Error(label + ' must be a whole number from ' + min + ' to ' + max + '.');
    return String(Number(value));
}
function mtu(value) { return value === '' ? '' : integer(value, 68, 65535, 'MTU'); }

return baseclass.extend({
    list: list,
    isVLAN: isVLAN,
    references: references,
    deviceType: function(name, info, sections) {
        var s = sections.filter(function(s) { return s['.type'] === 'device' && s.name === name; })[0];
        if (s && isVLAN(s)) return 'vlan';
        if (s && s.type === 'bridge') return 'bridge';
        if (name === 'lo') return 'loopback';
        if (info.wireless) return 'wireless';
        if (info.bridge) return 'bridge';
        if (info.devtype === 'dsa') return 'ethernet';
        return info.devtype || (info.type === 1 ? 'ethernet' : 'device');
    },
    validateVLAN: function(values, sections, devices, original) {
        var v = Object.assign({}, values), sid = original && original['.name'];
        v.name = String(v.name || '').trim();
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/.test(v.name) || v.name === 'lo')
            throw new Error('Use a device name of 1–15 letters, numbers, dots, hyphens or underscores.');
        v.vid = integer(v.vid, 1, 4094, 'VLAN ID');
        if (!/^(8021q|8021ad)$/.test(v.type)) throw new Error('Choose 802.1Q or 802.1ad.');
        v.mtu = mtu(v.mtu);
        var configured = sections.filter(function(s) { return s['.type'] === 'device' && s['.name'] !== sid; });
        var parent = sections.filter(function(s) { return s['.type'] === 'device' && s.name === v.ifname; })[0];
        var live = devices.filter(function(d) { return d.name === v.ifname; })[0];
        if (!v.ifname || v.ifname === v.name || !(parent && (isVLAN(parent) || parent.type === 'bridge') || live && /^(ethernet|bridge|vlan)$/.test(live.type)))
            throw new Error('Choose an Ethernet, bridge or VLAN parent device.');
        var seen = [v.name], cursor = v.ifname;
        while (cursor) {
            if (seen.indexOf(cursor) !== -1) throw new Error('VLAN parents must not form a loop.');
            seen.push(cursor);
            var ancestor = sections.filter(function(s) { return s['.type'] === 'device' && s.name === cursor; })[0];
            if (ancestor && ancestor.type === 'bridge' && (ancestor.vlan_filtering === '1' || sections.some(function(s) { return s['.type'] === 'bridge-vlan' && s.device === cursor; })))
                throw new Error('This bridge uses VLAN filtering. Configure its VLAN membership in Bridge / VLAN first, using the existing OpenWrt controls.');
            cursor = ancestor && isVLAN(ancestor) ? ancestor.ifname : null;
        }
        if (configured.some(function(s) { return s.name === v.name; }) ||
            (!original || original.name !== v.name) && devices.some(function(d) { return d.name === v.name; }))
            throw new Error('That device name already exists.');
        if (configured.some(function(s) { return isVLAN(s) && s.ifname === v.ifname && s.type === v.type && Number(s.vid) === Number(v.vid); }))
            throw new Error('That VLAN ID and protocol already exist on this parent.');
        // OpenWrt can also create VLANs implicitly from names such as eth0.20.
        var implicit = v.ifname + '.' + v.vid;
        if (v.type === '8021q' && (!original || original.name !== implicit) && devices.some(function(d) { return d.name === implicit; }))
            throw new Error('That VLAN already exists as ' + implicit + '. Manage it in the OpenWrt device controls.');
        if (original && original.name !== v.name && references(sections, original.name, sid).length)
            throw new Error('This VLAN is in use. Remove its interface, bridge or child VLAN references before renaming it.');
        var parentMTU = parent && parent.mtu || live && live.mtu;
        if (v.mtu && parentMTU && Number(v.mtu) > Number(parentMTU))
            throw new Error('VLAN MTU cannot exceed the parent MTU (' + parentMTU + ').');
        return v;
    },
    validateEthernet: function(values) {
        var mac = String(values.macaddr || '').trim();
        if (mac && (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac) || parseInt(mac.slice(0, 2), 16) % 2 || /^00(:00){5}$/.test(mac)))
            throw new Error('Enter a valid unicast MAC address, or leave it empty for the hardware default.');
        // Removing the UCI MTU option does not reset an already active netifd
        // device. Write the standard Ethernet MTU explicitly on reset.
        return {mtu: values.mtu === '' ? '1500' : mtu(values.mtu), macaddr: mac.toUpperCase()};
    },
    validateDraft: function(before, after, devices) {
        var self = this;
        after.filter(isVLAN).forEach(function(s) {
            var old = before.filter(function(b) { return b['.name'] === s['.name']; })[0];
            if (!old || JSON.stringify(old) !== JSON.stringify(s))
                self.validateVLAN(s, after, devices, old || {'.name': s['.name'], name: ''});
            // Also catch a parent MTU lowered after editing its child VLAN.
            var parent = after.filter(function(p) { return p['.type'] === 'device' && p.name === s.ifname; })[0];
            if (s.mtu && parent && parent.mtu && Number(s.mtu) > Number(parent.mtu))
                throw new Error(s.name + ': VLAN MTU cannot exceed parent ' + parent.name + ' MTU (' + parent.mtu + ').');
        });
    },
    operations: function(before, after) {
        var ops = [];
        before.filter(function(s) { return s['.type'] === 'device'; }).forEach(function(s) {
            if (!after.some(function(a) { return a['.name'] === s['.name']; })) ops.push({kind: 'remove', section: s});
        });
        after.filter(function(s) { return s['.type'] === 'device'; }).forEach(function(s) {
            var old = before.filter(function(b) { return b['.name'] === s['.name']; })[0];
            var values = {};
            ['name', 'type', 'ifname', 'vid', 'mtu', 'macaddr'].forEach(function(k) {
                if ((s[k] || '') !== (old && old[k] || '')) values[k] = s[k] || '';
            });
            if (!old || Object.keys(values).length) ops.push({kind: old ? 'set' : 'add', section: s, values: values});
        });
        return ops;
    },
    stage: function(uci, operations) {
        operations.forEach(function(op) {
            var sid = op.section['.name'];
            if (op.kind === 'remove') { uci.remove('network', sid); return; }
            if (op.kind === 'add') sid = uci.add('network', 'device');
            Object.keys(op.values).forEach(function(k) { uci.set('network', sid, k, op.values[k]); });
        });
    },
    rate: function(previous, current, seconds) {
        if (previous == null || current == null || seconds <= 0 || current < previous) return '—';
        var bps = (current - previous) * 8 / seconds;
        return bps >= 1000000 ? (bps / 1000000).toFixed(1) + ' Mbps' : bps >= 1000 ? (bps / 1000).toFixed(1) + ' kbps' : Math.round(bps) + ' bps';
    }
});
