'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require fs';
'require poll';
'require freeisp.bridge-data as data';

var status = rpc.declare({object: 'network.device', method: 'status', expect: {'': {}}, reject: true});
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function snapshot() {
    return fs.exec_direct('/usr/libexec/freeisp-bridge-status', [], 'json').then(data.decode).catch(function() {
        return {link: [], fdb: [], vlan: [], errors: ['Bridge telemetry unavailable. The router needs the bridge status helper and ip-bridge package.']};
    });
}
function text(v) { return v == null || v === '' ? '—' : String(v); }
function rate(v, bits) {
    if (v == null) return '—';
    if (!bits) return v.toFixed(0) + ' p/s';
    v *= 8;
    return v >= 1e9 ? (v / 1e9).toFixed(2) + ' Gbps' : v >= 1e6 ? (v / 1e6).toFixed(2) + ' Mbps' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' kbps' : v.toFixed(0) + ' bps';
}

return view.extend({
    load: function() { return Promise.all([uci.load('network'), status(), snapshot()]); },
    render: function(result) {
        var baseline = clone(uci.sections('network')), draft = clone(baseline), live = result[1], telemetry = result[2];
        var previous = clone(live), lastSample = performance.now(), traffic = {}, lastUpdated = new Date();
        var active = 'Bridge', selected = '', sortKey = 0, sortDirection = 1, page = 0, serial = 0;
        var busy = false, locked = false, refreshing = false, stale = false, paused = false, readonly = !L.hasViewPermission();
        var tabs = ['Bridge', 'Ports', 'VLANs', 'Hosts'], exported = [], exportHeaders = [];
        function button(label, action, primary) { return E('button', {type: 'button', 'class': 'br-button' + (primary ? ' br-primary' : ''), click: action}, label); }
        function mutation(label, action, primary) { var b = button(label, action, primary); b.disabled = readonly || busy || locked; return b; }
        function link(label) { return E('a', {'class': 'br-button', href: L.url('admin', 'network', 'network')}, label); }
        function error(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        function edits() { return data.operations(baseline, draft); }
        function bridgeNames() { return Array.from(new Set(data.bridges(draft).map(function(b) { return b.name; }).concat(Object.keys(live).filter(function(n) { return live[n].type === 'bridge' || live[n]['bridge-members']; })))).sort(); }
        function configured(name) { return data.bridges(draft).find(function(s) { return s.name === name; }); }
        function allBridges() { return bridgeNames().map(function(n) { return configured(n) || {name: n, runtime: true}; }); }
        function deviceSection(name) { return draft.find(function(s) { return s['.type'] === 'device' && s.name === name; }); }
        function addSection(type, values) { draft.push(Object.assign({'.name': 'freeisp_bridge_draft_' + (++serial), '.type': type}, values)); }
        function onOff(v) { return v == null || v === '' ? 'Default' : v === true || v === 1 || v === '1' ? 'Enabled' : 'Disabled'; }
        function badge(label, up) { return E('span', {'class': 'br-state' + (up ? ' is-up' : '')}, label); }
        function state(name) { var d = live[name]; return badge(stale ? 'Stale' : !d ? 'Not active' : d.up ? 'Running' : 'Down', !stale && d && d.up); }
        var defaults = [['', 'System default'], ['1', 'Enabled'], ['0', 'Disabled']];
        function field(key, label, value, options, placeholder) { return {key: key, label: label, value: value, options: options, placeholder: placeholder}; }
        function editor(title, specs, note, submit) {
            var controls = {}, notice = E('p', {'class': 'br-error', role: 'alert'});
            var rows = specs.map(function(s) {
                if (s.heading) return E('h4', {'class': 'br-editor-section'}, s.heading);
                var n = s.options ? E('select', {id: 'br-edit-' + s.key}, s.options.map(function(o) { return E('option', {value: o[0]}, o[1]); })) : E('input', {id: 'br-edit-' + s.key, type: 'text', placeholder: s.placeholder || '', maxlength: s.key === 'name' ? '15' : null});
                n.value = s.value == null ? '' : s.value; n.disabled = !!s.disabled; controls[s.key] = n;
                return E('div', {'class': 'br-field'}, [E('label', {'for': n.id}, s.label), n]);
            });
            ui.showModal(title, [E('div', {'class': 'br-editor'}, rows), E('p', {'class': 'br-hint'}, note), notice,
                E('div', {'class': 'br-modal-actions'}, [button('Cancel', ui.hideModal), mutation('Save to review', function() {
                    try {
                        var values = {}; Object.keys(controls).forEach(function(k) { values[k] = controls[k].value.trim(); });
                        submit(values); ui.hideModal(); draw();
                    } catch(e) { notice.textContent = e.message; }
                }, true)])]);
            var first = Object.keys(controls).find(function(k) { return !controls[k].disabled; });
            if (first) controls[first].focus();
        }
        function editBridge(s) {
            var v = s || {}, name = field('name', 'Bridge name', v.name, null, 'br-custom'); name.disabled = !!s;
            var specs = [{heading: 'General'}, name, field('mtu', 'MTU', v.mtu, null, 'Device default'), field('macaddr', 'MAC address', v.macaddr, null, 'Automatic'), field('bridge_empty', 'Keep empty bridge active', v.bridge_empty, defaults), field('vlan_filtering', 'VLAN filtering', v.vlan_filtering, defaults),
                {heading: 'Spanning tree'}, field('stp', 'Spanning Tree Protocol', v.stp, defaults), field('priority', 'Bridge priority', v.priority, null, '32767'), field('hello_time', 'Hello interval · seconds', v.hello_time, null, '1'), field('forward_delay', 'Forward delay · seconds', v.forward_delay, null, '8'), field('max_age', 'Maximum age · seconds', v.max_age, null, '10'), field('ageing_time', 'MAC ageing time · seconds', v.ageing_time, null, 'Kernel default'),
                {heading: 'Multicast'}, field('igmp_snooping', 'IGMP snooping', v.igmp_snooping, defaults), field('multicast_querier', 'Multicast querier', v.multicast_querier, defaults), field('hash_max', 'Snooping table size', v.hash_max, null, '512'), field('robustness', 'Robustness', v.robustness, null, '2'), field('query_interval', 'Query interval · centiseconds', v.query_interval, null, '12500'), field('query_response_interval', 'Query response interval · centiseconds', v.query_response_interval, null, '1000'), field('last_member_interval', 'Last member interval · centiseconds', v.last_member_interval, null, '100')];
            editor(s ? 'Bridge settings · ' + s.name : 'Add bridge', specs, 'Empty fields use OpenWrt defaults. Configure port membership and VLANs in their tabs. VLAN filtering can interrupt management; assign the correct VLAN device to your management interface before applying. STP here is the standard OpenWrt control; RSTP/MSTP requires separate daemon support.', function(values) {
                var valid = data.validateBridge(values, draft, Object.keys(live), s);
                if (s) Object.assign(s, valid); else addSection('device', valid);
            });
        }
        function removeBridge(s) {
            var refs = data.references(draft, s.name, s['.name']);
            if (refs.length) return error(new Error('Remove references to ' + s.name + ' first: ' + refs.join(', ') + '.'));
            confirmRemoval('Remove bridge ' + s.name + '?', 'Its ports will be detached when changes are applied.', function() { draft = draft.filter(function(d) { return d !== s; }); });
        }
        function confirmRemoval(title, note, action) {
            ui.showModal(title, [E('p', {}, note), E('div', {'class': 'br-modal-actions'}, [button('Cancel', ui.hideModal), mutation('Remove from draft', function() { action(); ui.hideModal(); draw(); }, true)])]);
        }
        function addPort() {
            var bs = data.bridges(draft), names = Object.keys(live).concat(draft.filter(function(s) { return s['.type'] === 'device'; }).map(function(s) { return s.name; }));
            editor('Add bridge port', [field('bridge', 'Bridge', selected, [['', 'Choose a bridge']].concat(bs.map(function(b) { return [b.name, b.name]; }))), field('port', 'Port', '', [['', 'Choose a port']].concat(Array.from(new Set(names)).filter(function(n) { return n && n !== 'lo' && !configured(n) && (live[n] || {}).type !== 'bridge'; }).sort().map(function(n) { return [n, n]; })))], 'A port can belong to one bridge. Ports assigned directly to a routed interface must be reassigned in Interfaces first. Wireless membership is managed in wireless network settings.', function(v) {
                var b = configured(v.bridge); if (!b) throw new Error('Choose a configured bridge.');
                if (!v.port) throw new Error('Choose a port.');
                data.validateMembership(v.port, b, draft, live);
                if (data.ports(draft, b).indexOf(v.port) !== -1) throw new Error('This port is already a member.');
                b.ports = data.list(b.ports).concat([v.port]);
            });
        }
        function editPort(name) {
            var s = deviceSection(name) || {};
            editor('Port settings · ' + name, [field('learning', 'MAC learning', s.learning, defaults), field('unicast_flood', 'Unknown unicast flooding', s.unicast_flood, defaults), field('isolate', 'Port isolation', s.isolate, defaults), field('multicast_to_unicast', 'Multicast to unicast', s.multicast_to_unicast, defaults), field('multicast_fast_leave', 'Multicast fast leave', s.multicast_fast_leave, defaults), field('multicast_router', 'Multicast router', s.multicast_router, [['', 'System default'], ['0', 'Never'], ['1', 'Learn'], ['2', 'Always']])], 'These persistent device settings apply wherever this port is attached. Default removes the explicit override. PVID and tagging are managed in VLANs.', function(v) {
                var valid = data.validatePort(v), existing = deviceSection(name);
                if (existing) Object.assign(existing, valid); else if (Object.values(valid).some(Boolean)) addSection('device', Object.assign({name: name}, valid));
            });
        }
        function removePort(b, name) {
            var refs = data.vlans(draft, b.name).filter(function(v) { return data.list(v.ports).some(function(p) { return data.member(p).name === name; }); });
            if (refs.length) return error(new Error('Remove this port from VLANs ' + refs.map(function(v) { return v.vlan; }).join(', ') + ' first.'));
            confirmRemoval('Detach ' + name + ' from ' + b.name + '?', 'Traffic through this port will stop using this bridge after applying. Device settings are retained.', function() { b.ports = data.list(b.ports).filter(function(p) { return p !== name; }); });
        }
        function chooseVLANBridge() {
            if (selected && configured(selected)) return editVLAN(configured(selected));
            editor('Choose VLAN bridge', [field('bridge', 'Bridge', '', [['', 'Choose a bridge']].concat(data.bridges(draft).map(function(b) { return [b.name, b.name]; })))], 'VLAN entries define bridge access and trunk membership.', function(v) {
                var b = configured(v.bridge); if (!b) throw new Error('Choose a configured bridge.');
                // Open the next editor after the chooser closes.
                setTimeout(function() { editVLAN(b); }, 0);
            });
        }
        function editVLAN(b, s) {
            var v = s || {}, members = data.ports(draft, b), specs = [field('vlan', 'VLAN ID', v.vlan, null, '1–4094'), field('local', 'Router participates', v.local === '0' ? '0' : '1', [['1', 'Yes · local / CPU port'], ['0', 'No · switching only']]), {heading: 'Port membership'}];
            members.forEach(function(name, i) {
                var m = data.list(v.ports).map(data.member).find(function(p) { return p.name === name; });
                specs.push(field('port' + i, name, !m ? '' : (m.tagged ? 't' : 'u') + (m.pvid ? '*' : ''), [['', 'Not a member'], ['t', 'Tagged'], ['u', 'Untagged'], ['u*', 'Untagged · PVID'], ['t*', 'Tagged · PVID']]));
            });
            editor((s ? 'Edit' : 'Add') + ' VLAN · ' + b.name, specs, 'Tagged keeps the VLAN tag on egress; untagged removes it. PVID classifies incoming untagged frames; choose only one per port. Router participation is needed for an IP interface on this VLAN. Enable bridge VLAN filtering separately; no routing or firewall rules are created here.', function(values) {
                var ports = members.filter(function(n, i) { return !!values['port' + i]; }).map(function(n) { return n + ':' + values['port' + members.indexOf(n)]; });
                var valid = data.validateVLAN({vlan: values.vlan, local: values.local, ports: ports}, draft, b, s);
                if (s) Object.assign(s, valid); else addSection('bridge-vlan', valid);
            });
        }
        function removeVLAN(s) {
            var refs = data.references(draft, s.device + '.' + s.vlan, s['.name']);
            data.list(s.alias).forEach(function(a) { refs = refs.concat(data.references(draft, s.device + '.' + a, s['.name'])); });
            if (refs.length) return error(new Error('This VLAN is still referenced by ' + Array.from(new Set(refs)).join(', ') + '.'));
            confirmRemoval('Remove VLAN ' + s.vlan + ' from ' + s.device + '?', 'This removes its port membership after applying.', function() { draft = draft.filter(function(d) { return d !== s; }); });
        }
        function review() {
            var ops = edits(); if (!ops.length || readonly || busy || locked) return;
            ui.showModal('Review bridge changes', [E('p', {}, 'These changes may interrupt management traffic. OpenWrt will apply them with automatic rollback unless connectivity is confirmed. Review all affected bridge, port and VLAN settings.'),
                E('div', {'class': 'br-review'}, ops.map(function(op) { return E('div', {}, [E('strong', {}, (op.kind === 'add' ? 'Add ' : op.kind === 'remove' ? 'Remove ' : 'Update ') + (op.section.name || op.section.device + ' · VLAN ' + op.section.vlan)), E('ul', {}, Object.keys(op.values || {}).map(function(k) { var v = op.values[k]; return E('li', {}, k + ': ' + (Array.isArray(v) ? v.join(', ') || '(none)' : v || '(default)')); }))]); })),
                E('div', {'class': 'br-modal-actions'}, [button('Back', ui.hideModal), mutation('Apply with rollback', function() { ui.hideModal(); apply(ops); }, true)])]);
        }
        async function apply(ops) {
            if (readonly || busy || locked) return;
            busy = true; draw(); var staged = false;
            try {
                var pending = await uci.changes();
                if (Object.keys(pending).some(function(k) { return pending[k].length; })) throw new Error('Apply or revert existing OpenWrt pending changes before applying this draft.');
                uci.unload('network'); await uci.load('network');
                if (JSON.stringify(uci.sections('network')) !== JSON.stringify(baseline)) throw new Error('Network configuration changed on another page or session. Reload this page and recreate your edits against the latest settings.');
                staged = true;
                ops.forEach(function(op) {
                    if (op.kind === 'remove') return uci.remove('network', op.section['.name']);
                    var id = op.kind === 'add' ? uci.add('network', op.section['.type']) : op.section['.name'];
                    Object.keys(op.values).forEach(function(k) { var v = op.values[k]; if (v === '' || Array.isArray(v) && !v.length) uci.unset('network', id, k); else uci.set('network', id, k, v); });
                });
                await uci.save(); await ui.changes.init();
                document.addEventListener('uci-applied', function() { window.location.reload(); }, {once: true});
                locked = true; await ui.changes.apply(true);
            } catch(e) {
                if (staged) { locked = true; error(new Error('The save/apply flow did not finish. Review OpenWrt pending changes and reload before retrying. ' + (e.message || e))); }
                else error(e);
            } finally { busy = false; draw(); }
        }
        var health = E('span', {'class': 'br-health', role: 'status'}), summary = E('div', {'class': 'br-summary'});
        var tabbar = E('div', {'class': 'br-tabs', role: 'tablist', 'aria-label': 'Bridge sections'});
        tabs.forEach(function(t, i) {
            var b = button(t, function() { active = t; page = 0; sortKey = 0; search.value = ''; draw(); });
            b.id = 'br-tab-' + i; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'br-panel');
            b.addEventListener('keydown', function(e) {
                var next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
                if (next >= 0) { e.preventDefault(); active = tabs[next]; page = 0; sortKey = 0; search.value = ''; draw(); tabbar.children[next].focus(); }
            }); tabbar.appendChild(b);
        });
        var search = E('input', {type: 'search', placeholder: 'Find name, port, MAC or VLAN…', 'aria-label': 'Find bridge entries', input: function() { page = 0; drawTable(); }});
        var scope = E('select', {'aria-label': 'Filter by bridge', change: function() { selected = scope.value; page = 0; drawTable(); }});
        var kind = E('select', {'aria-label': 'Host entry type', change: function() { page = 0; drawTable(); }}, ['', 'Dynamic', 'Static', 'Local'].map(function(k) { return E('option', {value: k}, k || 'All host types'); }));
        var pause = button('Pause', function() { paused = !paused; pause.textContent = paused ? 'Resume' : 'Pause'; drawHealth(); if (!paused) refresh(); });
        var refreshButton = button('Refresh', function() { refresh(); });
        var toolbar = E('div', {'class': 'br-toolbar'}), table = E('div', {'class': 'br-table-wrap'}), pagination = E('div', {'class': 'br-pagination'}), note = E('p', {'class': 'br-hint'}), footer = E('div', {'class': 'br-footer'}), warnings = E('div', {'class': 'br-warnings', role: 'status'});
        var panel = E('section', {id: 'br-panel', role: 'tabpanel'}, [toolbar, warnings, table, pagination, note]);
        var root = E('div', {'class': 'br-window'}, [E('link', {rel: 'stylesheet', href: L.resource('freeisp/bridge.css') + '?v=1'}), E('div', {'class': 'br-heading'}, [E('div', {}, [E('h2', {}, 'Bridge'), E('p', {}, 'Layer 2 connections, VLAN membership and learned hosts.')]), health]), summary, E('div', {'class': 'br-card'}, [tabbar, panel, footer])]);
        function rowsForTab() {
            var rows = [], headings;
            if (active === 'Bridge') {
                headings = ['Name', 'Status', 'MTU', 'Tx', 'Rx', 'Tx packets', 'Rx packets', 'MAC address', 'STP', 'VLAN filtering', 'Ports', 'Actions'];
                allBridges().filter(function(b) { return !selected || selected === b.name; }).forEach(function(b) {
                    var d = live[b.name] || {}, r = traffic[b.name] || {}, attrs = d['bridge-attributes'] || {};
                    rows.push([b.name, state(b.name), text(d.mtu || b.mtu), rate(r.tx_bytes, true), rate(r.rx_bytes, true), rate(r.tx_packets), rate(r.rx_packets), text(d.macaddr || b.macaddr), onOff(b.stp == null ? attrs.stp : b.stp), onOff(b.vlan_filtering == null ? attrs.vlan_filtering : b.vlan_filtering), String(b.runtime ? data.list(d['bridge-members']).length : data.ports(draft, b).length), b.runtime ? link('Manage in Interfaces') : E('div', {'class': 'br-row-actions'}, [mutation('Settings', function() { editBridge(b); }), mutation('Remove', function() { removeBridge(b); })])]);
                });
            } else if (active === 'Ports') {
                headings = ['Port', 'Bridge', 'Membership', 'Link', 'STP state', 'PVID · live', 'Path cost · live', 'Learning', 'Isolation', 'Tx', 'Rx', 'Actions'];
                allBridges().filter(function(b) { return !selected || selected === b.name; }).forEach(function(b) {
                    var configuredPorts = b.runtime ? [] : data.ports(draft, b), current = data.list((live[b.name] || {})['bridge-members']);
                    Array.from(new Set(configuredPorts.concat(current))).sort().forEach(function(name) {
                        var d = live[name] || {}, s = deviceSection(name) || {}, p = telemetry.link.find(function(p) { return p.ifname === name && p.master === b.name; }) || {}, r = traffic[name] || {};
                        var vlan = telemetry.vlan.find(function(v) { return v.ifname === name; }), pvid = vlan && (vlan.vlans || []).find(function(v) { return data.list(v.flags).indexOf('PVID') !== -1; });
                        var member = configuredPorts.indexOf(name) !== -1;
                        rows.push([name, b.name, member ? 'Configured' : 'Runtime only', stale ? 'Stale' : d.carrier == null ? '—' : d.carrier ? 'Connected' : 'No link', text(p.state), pvid ? text(pvid.vlan) : '—', text(p.cost), onOff(s.learning == null ? p.learning : s.learning), onOff(s.isolate == null ? p.isolated : s.isolate), rate(r.tx_bytes, true), rate(r.rx_bytes, true), member ? E('div', {'class': 'br-row-actions'}, [mutation('Settings', function() { editPort(name); }), mutation('Detach', function() { removePort(b, name); })]) : link('Manage in Interfaces')]);
                    });
                });
            } else if (active === 'VLANs') {
                headings = ['VLAN ID', 'Bridge', 'Filtering', 'Router / CPU', 'Tagged ports', 'Untagged ports', 'PVID ports', 'Used by', 'Actions'];
                draft.filter(function(s) { return s['.type'] === 'bridge-vlan' && (!selected || s.device === selected); }).forEach(function(s) {
                    var b = configured(s.device), members = data.list(s.ports).map(data.member);
                    rows.push([Number(s.vlan), s.device, b && b.vlan_filtering === '0' ? 'Disabled' : b && b.vlan_filtering === '1' ? 'Enabled' : 'Automatic', s.local === '0' ? 'Excluded' : 'Included', members.filter(function(p) { return p.tagged; }).map(function(p) { return p.name; }).join(', ') || '—', members.filter(function(p) { return !p.tagged; }).map(function(p) { return p.name; }).join(', ') || '—', members.filter(function(p) { return p.pvid; }).map(function(p) { return p.name; }).join(', ') || '—', data.references(draft, s.device + '.' + s.vlan, s['.name']).join(', ') || '—', b ? E('div', {'class': 'br-row-actions'}, [mutation('Edit', function() { editVLAN(b, s); }), mutation('Remove', function() { removeVLAN(s); })]) : link('Manage in Interfaces')]);
                });
            } else {
                headings = ['MAC address', 'Bridge', 'Port', 'VLAN ID', 'Type', 'Flags / state', 'Last used · seconds', 'Last updated · seconds'];
                data.hosts(telemetry, live).filter(function(h) { return (!selected || h.bridge === selected) && (!kind.value || h.kind === kind.value); }).forEach(function(h) { rows.push([h.mac, h.bridge, h.port, text(h.vlan), h.kind, h.flags || '—', text(h.used), text(h.updated)]); });
            }
            return {headings: headings, rows: rows};
        }
        function cellValue(v) { return typeof v === 'object' && v !== null ? v.textContent : text(v); }
        function drawTable() {
            var contents = rowsForTab(), query = search.value.trim().toLowerCase(), count = contents.rows.length;
            var rows = contents.rows.filter(function(row) { return row.slice(0, active === 'Hosts' ? row.length : -1).some(function(v) { return cellValue(v).toLowerCase().indexOf(query) !== -1; }); });
            rows.sort(function(a, b) { return sortDirection * cellValue(a[sortKey]).localeCompare(cellValue(b[sortKey]), undefined, {numeric: true, sensitivity: 'base'}); });
            exported = rows.map(function(row) { return row.slice(0, active === 'Hosts' ? row.length : -1).map(cellValue); });
            exportHeaders = contents.headings.slice(0, active === 'Hosts' ? contents.headings.length : -1);
            page = Math.min(page, Math.max(0, Math.ceil(rows.length / 100) - 1));
            var shown = rows.slice(page * 100, (page + 1) * 100);
            table.replaceChildren(E('table', {'class': 'br-table'}, [E('thead', {}, E('tr', {}, contents.headings.map(function(h, i) {
                var sortable = h !== 'Actions';
                return E('th', {scope: 'col', 'aria-sort': sortable && i === sortKey ? sortDirection === 1 ? 'ascending' : 'descending' : null}, sortable ? button(h, function() { sortDirection = sortKey === i ? -sortDirection : 1; sortKey = i; drawTable(); }) : h);
            }))), E('tbody', {}, shown.length ? shown.map(function(row) { return E('tr', {}, row.map(function(v) { return E('td', {}, typeof v === 'object' ? v : text(v)); })); }) : E('tr', {}, E('td', {colspan: contents.headings.length, 'class': 'br-empty'}, query ? 'No matching entries. Clear the search or change the bridge filter.' : active === 'Hosts' && telemetry.errors.length ? 'Host data is unavailable. Check the status message above.' : active === 'Hosts' ? 'No forwarding entries learned for this selection.' : active === 'VLANs' ? 'No VLAN entries. Add a VLAN to define access and trunk ports.' : active === 'Ports' ? 'No member ports. Add a port to a configured bridge.' : 'No bridges. Add a bridge to get started.')))]));
            var prev = button('Previous', function() { page--; drawTable(); }), next = button('Next', function() { page++; drawTable(); });
            prev.disabled = page === 0; next.disabled = (page + 1) * 100 >= rows.length;
            pagination.replaceChildren(E('span', {}, rows.length + ' of ' + count + ' entries' + (rows.length > 100 ? ' · Page ' + (page + 1) + ' of ' + Math.ceil(rows.length / 100) : '')), prev, next);
        }
        function drawHealth() {
            health.textContent = (stale ? 'Status unavailable · last sample ' : paused ? 'Paused · last sample ' : 'Live · updated ') + lastUpdated.toLocaleTimeString();
            health.classList.toggle('is-stale', stale);
            warnings.replaceChildren.apply(warnings, (stale ? ['Refresh failed. Displayed runtime values are from the last successful sample.'] : []).concat(telemetry.errors).map(function(w) { return E('p', {}, w); }));
        }
        function draw() {
            var names = bridgeNames(); if (selected && names.indexOf(selected) === -1) selected = '';
            scope.replaceChildren.apply(scope, [E('option', {value: ''}, 'All bridges')].concat(names.map(function(n) { return E('option', {value: n}, n); }))); scope.value = selected;
            tabbar.querySelectorAll('button').forEach(function(b, i) { b.setAttribute('aria-selected', String(tabs[i] === active)); b.setAttribute('tabindex', tabs[i] === active ? '0' : '-1'); });
            panel.setAttribute('aria-labelledby', 'br-tab-' + tabs.indexOf(active));
            var controls = [];
            if (active === 'Bridge') controls.push(mutation('+ Add bridge', function() { editBridge(); }, true));
            if (active === 'Ports') controls.push(mutation('+ Add port', addPort, true));
            if (active === 'VLANs') controls.push(mutation('+ Add VLAN', chooseVLANBridge, true));
            controls.push(scope); if (active === 'Hosts') controls.push(kind);
            controls.push(search, refreshButton, pause, button('Export CSV', function() {
                var url = URL.createObjectURL(new Blob([data.csv(exportHeaders, exported)], {type: 'text/csv;charset=utf-8'}));
                var a = E('a', {href: url, download: 'bridge-' + active.toLowerCase() + '.csv'});
                document.body.appendChild(a); a.click(); a.remove(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
            }));
            toolbar.replaceChildren.apply(toolbar, controls);
            note.textContent = active === 'Bridge' ? 'Settings include your draft; status and traffic are live. Tx / Rx are measured rates, sampled every 5 seconds. MTU is the reported IP MTU. Hardware offload and FastPath counters are not inferred.' : active === 'Ports' ? 'Configured membership includes draft changes; runtime-only ports may be dynamic or waiting for apply. Link, STP state, path cost and PVID are live. Port settings show explicit overrides where present.' : active === 'VLANs' ? 'This table is the configured bridge VLAN policy, including your draft. Enable VLAN filtering in Bridge settings. Create VLAN IP interfaces, DHCP and firewall rules separately in Interfaces. Router / CPU participation is distinct from external tagged ports.' : 'Read-only forwarding database from the Linux bridge. Local entries belong to the router; dynamic entries are learned MAC addresses. This is not the DHCP lease or IP neighbor table. Missing counters are shown as —; export includes all filtered rows.';
            var changeCount = edits().length, applyButton = mutation(busy ? 'Applying…' : 'Review & apply', review, true), discard = button('Discard edits', function() { draft = clone(baseline); draw(); });
            applyButton.disabled = applyButton.disabled || !changeCount; discard.disabled = !changeCount || busy || locked;
            footer.replaceChildren(E('span', {role: 'status'}, locked ? 'Review pending OpenWrt changes and reload this page.' : readonly ? 'Read-only access' : changeCount ? changeCount + ' configuration changes to review' : 'No pending edits'), link('IP interfaces'), discard, applyButton);
            drawSummary(); drawHealth(); drawTable();
        }
        function drawSummary() {
            var names = bridgeNames(), hostCount = data.hosts(telemetry, live).length;
            summary.replaceChildren.apply(summary, [[names.length, 'Bridges'], [Object.keys(live).filter(function(n) { return names.indexOf(n) !== -1 && live[n].up; }).length, 'Running'], [draft.filter(function(s) { return s['.type'] === 'bridge-vlan'; }).length, 'Configured VLANs'], [telemetry.errors.length ? '—' : hostCount, 'Learned / local hosts']].map(function(item) { return E('div', {}, [E('strong', {}, String(item[0])), E('span', {}, item[1])]); }));
        }
        async function refresh() {
            if (refreshing || busy || locked) return;
            refreshing = true; refreshButton.disabled = true;
            try {
                var values = await Promise.all([status(), snapshot()]), now = performance.now();
                traffic = data.rates(previous, values[0], (now - lastSample) / 1000);
                previous = clone(values[0]); lastSample = now; live = values[0]; telemetry = values[1]; lastUpdated = new Date(); stale = false;
            } catch(e) { stale = true; traffic = {}; previous = {}; }
            finally { refreshing = false; refreshButton.disabled = false; drawSummary(); drawHealth(); drawTable(); }
        }
        draw();
        window.addEventListener('beforeunload', function(e) { if (root.isConnected && !locked && edits().length) { e.preventDefault(); e.returnValue = ''; } });
        poll.add(function() { if (!paused && root.isConnected) return refresh(); }, 5);
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
