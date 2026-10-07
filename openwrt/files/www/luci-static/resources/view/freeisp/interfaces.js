'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require poll';
'require freeisp.interfaces-data as data';

var dump = rpc.declare({object: 'network.interface', method: 'dump', expect: {interface: []}, reject: true});
var status = rpc.declare({object: 'network.device', method: 'status', expect: {'': {}}, reject: true});
var metadata = rpc.declare({object: 'luci-rpc', method: 'getNetworkDevices', expect: {'': {}}, reject: true});
function clone(value) { return JSON.parse(JSON.stringify(value)); }

return view.extend({
    load: function() { return Promise.all([uci.load('network'), metadata(), dump(), status()]); },
    render: function(result) {
        var self = this, baseline = clone(uci.sections('network')), draft = clone(baseline);
        var devices = Object.keys(result[1]).map(function(name) { var d = result[1][name]; return {name: name, type: data.deviceType(name, d, baseline), mtu: d.mtu}; });
        var states = result[2], live = result[3], previous = {}, previousTime = 0, rates = {}, active = 'Interface', serial = 0, busy = false, failed = false, submitted = false, applied = false;
        var tabs = ['Interface', 'Interface List', 'Ethernet', 'VLAN'];
        var readonly = !L.hasViewPermission();
        function button(text, click, primary) { return E('button', {type: 'button', 'class': 'if-button' + (primary ? ' if-primary' : ''), click: click}, text); }
        function advanced(text) { return E('a', {'class': 'if-button', href: L.url('admin', 'network', 'network')}, text); }
        function error(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        function edits() { return data.operations(baseline, draft); }
        function badge(up, label) { return E('span', {'class': 'if-state' + (up ? ' is-up' : '')}, label || (up ? 'Up' : 'Down')); }
        function deviceSection(name) { return draft.filter(function(s) { return s['.type'] === 'device' && s.name === name; })[0]; }
        function type(name) { var s = deviceSection(name), d = devices.filter(function(d) { return d.name === name; })[0]; return s && data.isVLAN(s) ? 'vlan' : d ? d.type : s ? s.type : 'device'; }
        function names() { return Array.from(new Set(Object.keys(live).concat(draft.filter(function(s) { return s['.type'] === 'device'; }).map(function(s) { return s.name; })))).filter(Boolean).sort(); }
        function editor(title, specs, submit, help) {
            var fields = {}, notice = E('p', {'class': 'if-error', role: 'alert'});
            var rows = specs.map(function(s) {
                var control = s.options ? E('select', {id: 'if-edit-' + s.key}, s.options.map(function(o) { return E('option', {value: o[0]}, o[1]); })) : E('input', {id: 'if-edit-' + s.key, type: 'text', placeholder: s.placeholder || ''});
                control.value = s.value || ''; fields[s.key] = control;
                return E('div', {'class': 'if-field'}, [E('label', {'for': control.id}, s.label), control]);
            });
            var save = button('Save to review', function() {
                try {
                    var values = {}; Object.keys(fields).forEach(function(k) { values[k] = fields[k].value.trim(); });
                    submit(values); ui.hideModal(); draw();
                } catch(e) { notice.textContent = e.message; }
            }, true);
            ui.showModal(title, [E('div', {'class': 'if-editor'}, rows.concat([notice, E('p', {'class': 'if-muted'}, help || 'Saved edits stay on this page until you review and apply them.')])), E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), save])]);
            fields[specs[0].key].focus();
        }
        function editVLAN(section) {
            var s = section || {}, parents = names().filter(function(n) { return n !== s.name && /^(ethernet|bridge|vlan)$/.test(type(n)); });
            if (s.ifname && parents.indexOf(s.ifname) === -1) parents.push(s.ifname);
            editor(s.name ? 'Edit VLAN · ' + s.name : 'Add VLAN', [
                {key: 'name', label: 'Name', value: s.name, placeholder: 'vlan20'},
                {key: 'ifname', label: 'Parent interface', value: s.ifname, options: [['', 'Select a parent interface']].concat(parents.map(function(n) { return [n, n]; }))},
                {key: 'vid', label: 'VLAN ID', value: s.vid, placeholder: '1–4094'},
                {key: 'type', label: 'Protocol', value: s.type || '8021q', options: [['8021q', '802.1Q · Customer VLAN'], ['8021ad', '802.1ad · Service VLAN']]},
                {key: 'mtu', label: 'MTU', value: s.mtu, placeholder: 'Inherit from parent'}
            ], function(values) {
                var valid = data.validateVLAN(values, draft, devices, section);
                if (section) Object.assign(section, valid);
                else draft.push(Object.assign({'.name': 'freeisp_draft_' + (++serial), '.type': 'device'}, valid));
            });
        }
        function editEthernet(name) {
            var s = deviceSection(name) || {};
            editor('Ethernet · ' + name, [
                {key: 'mtu', label: 'MTU', value: s.mtu, placeholder: '1500'},
                {key: 'macaddr', label: 'MAC address', value: s.macaddr, placeholder: 'No saved override'}
            ], function(values) {
                var valid = data.validateEthernet(values), section = deviceSection(name);
                if (section) Object.assign(section, valid);
                else if (valid.mtu || valid.macaddr) draft.push(Object.assign({'.name': 'freeisp_draft_' + (++serial), '.type': 'device', name: name}, valid));
            }, 'Empty MTU uses 1500. Empty MAC removes the saved override; restart the device to restore its hardware address. Review and apply to save.');
        }
        function removeVLAN(s) {
            var refs = data.references(draft, s.name, s['.name']);
            if (refs.length) { error(new Error('Cannot remove ' + s.name + ': used by ' + refs.join(', ') + '. Remove these references first.')); return; }
            ui.showModal('Remove VLAN', [E('p', {}, 'Remove ' + s.name + ' (VLAN ' + s.vid + ')? This will be included in your pending edits.'), E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), button('Remove VLAN', function() { draft = draft.filter(function(d) { return d !== s; }); ui.hideModal(); draw(); }, true)])]);
        }
        function review() {
            var ops = edits();
            if (!ops.length || busy || failed || submitted) return;
            try { data.validateDraft(baseline, draft, devices); } catch(e) { error(e); return; }
            ui.showModal('Review interface changes', [
                E('p', {}, 'Changing a device used for management may interrupt this connection. OpenWrt will apply with automatic rollback if connectivity cannot be confirmed.'),
                E('ul', {}, ops.map(function(op) {
                    return E('li', {}, op.kind === 'remove' ? 'Remove ' + op.section.name : (op.kind === 'add' ? 'Add ' : 'Update ') + op.section.name + ': ' + Object.keys(op.values).map(function(k) { return k + ' = ' + (op.values[k] || 'default'); }).join(', '));
                })),
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), button('Apply changes', function() { ui.hideModal(); self.applyEdits(ops); }, true)])
            ]);
        }
        self.applyEdits = async function(ops) {
            if (busy || failed || submitted || readonly) return;
            busy = true; draw();
            var staged = false;
            try {
                var pending = await uci.changes();
                if (Object.keys(pending).some(function(k) { return pending[k].length; })) throw new Error('There are already pending OpenWrt changes. Apply or revert them before applying this page.');
                uci.unload('network'); await uci.load('network');
                if (JSON.stringify(uci.sections('network')) !== JSON.stringify(baseline)) throw new Error('Network settings have changed since this page loaded. Reload and review your edits against the latest settings.');
                staged = true; data.stage(uci, ops); await uci.save(); await ui.changes.init();
                document.addEventListener('uci-applied', function() { applied = true; window.location.reload(); }, {once: true});
                await ui.changes.apply(true);
                // LuCI owns the asynchronous apply/confirm dialog. Do not allow a
                // second save against the old baseline while it is running.
                submitted = true;
            } catch(e) {
                if (staged) { failed = true; error(new Error('Saving or applying did not finish. Review OpenWrt pending changes and reload this page before retrying. ' + (e.message || e))); }
                else error(e);
            } finally { busy = false; draw(); }
        };
        var tabbar = E('div', {'class': 'if-tabs', role: 'tablist', 'aria-label': 'Interface sections'});
        tabs.forEach(function(t, i) {
            var b = button(t, function() { active = t; search.value = ''; draw(); });
            b.setAttribute('role', 'tab'); b.id = 'if-tab-' + i; b.setAttribute('aria-controls', 'if-panel');
            b.addEventListener('keydown', function(e) {
                var next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
                if (next !== -1) { e.preventDefault(); active = tabs[next]; search.value = ''; draw(); tabbar.children[next].focus(); }
            }); tabbar.appendChild(b);
        });
        var search = E('input', {type: 'search', placeholder: 'Find an interface…', 'aria-label': 'Find an interface', input: function() { drawTable(); }});
        var toolbar = E('div', {'class': 'if-toolbar'}), table = E('div', {'class': 'if-table-wrap'}), note = E('p', {'class': 'if-help'}), footer = E('div', {'class': 'if-footer'});
        var health = E('span', {'class': 'if-muted', role: 'status'}, 'Live · refreshes every 5 seconds');
        var panel = E('section', {id: 'if-panel', role: 'tabpanel'}, [toolbar, table, note]);
        var root = E('div', {'class': 'if-window'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/interfaces.css') + '?v=1'}),
            E('div', {'class': 'if-heading'}, [E('div', {}, [E('h2', {}, 'Interfaces'), E('p', {}, 'Connections, ports and tagged networks.')]), health]),
            E('div', {'class': 'if-card'}, [tabbar, panel, footer])
        ]);
        function actions(s) { return E('div', {'class': 'if-row-actions'}, [button('Edit', function() { editVLAN(s); }), button('Remove', function() { removeVLAN(s); })]); }
        function drawTable() {
            var headings, rows = [], query = search.value.toLowerCase();
            if (active === 'Interface List') {
                headings = ['Name', 'Status', 'Protocol', 'Device', 'IPv4 address', 'IPv6 address'];
                draft.filter(function(s) { return s['.type'] === 'interface'; }).forEach(function(s) {
                    var state = states.filter(function(v) { return v.interface === s['.name']; })[0] || {};
                    rows.push([s['.name'], badge(state.up, s.disabled === '1' ? 'Disabled' : null), s.proto || '—', s.device || s.ifname || state.device || '—', (state['ipv4-address'] || []).map(function(a) { return a.address + '/' + a.mask; }).join(', ') || s.ipaddr || '—', (state['ipv6-address'] || []).map(function(a) { return a.address + '/' + a.mask; }).join(', ') || '—']);
                });
            } else if (active === 'VLAN') {
                headings = ['Name', 'Status', 'VLAN ID', 'Parent interface', 'Protocol', 'MTU', 'Used by', 'Actions'];
                draft.filter(data.isVLAN).forEach(function(s) {
                    var d = live[s.name] || {};
                    rows.push([s.name, badge(d.up, !d.present && !d.up ? 'Not active' : null), s.vid, s.ifname, s.type === '8021ad' ? '802.1ad' : '802.1Q', s.mtu || 'Inherit', data.references(draft, s.name, s['.name']).join(', ') || 'Unassigned', actions(s)]);
                });
                names().filter(function(n) { return type(n) === 'vlan' && !draft.some(function(s) { return data.isVLAN(s) && s.name === n; }); }).forEach(function(n) {
                    rows.push([n, badge((live[n] || {}).up), '—', '—', 'Managed by OpenWrt', (live[n] || {}).mtu || '—', 'Implicit / bridge VLAN', advanced('Configure')]);
                });
            } else {
                headings = active === 'Ethernet' ? ['Name', 'Status', 'MAC address', 'MTU', 'Link speed', 'Tx', 'Rx', 'Actions'] : ['Name', 'Type', 'Status', 'MTU', 'Tx', 'Rx', 'Tx packets', 'Rx packets'];
                names().filter(function(n) { return active !== 'Ethernet' || type(n) === 'ethernet'; }).forEach(function(n) {
                    var d = live[n] || {}, stats = d.statistics || {}, rate = rates[n] || {}, s = deviceSection(n) || {};
                    rows.push(active === 'Ethernet' ? [n, badge(d.carrier), d.macaddr || '—', d.mtu || '—', d.speed || '—', rate.tx || '—', rate.rx || '—', button('Edit', function() { editEthernet(n); })] : [n, type(n), badge(d.up), d.mtu || s.mtu || '—', rate.tx || '—', rate.rx || '—', stats.tx_packets == null ? '—' : String(stats.tx_packets), stats.rx_packets == null ? '—' : String(stats.rx_packets)]);
                });
            }
            rows = rows.filter(function(row) { return row.some(function(v) { return (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().indexOf(query) !== -1; }); });
            table.replaceChildren(E('table', {'class': 'if-table'}, [E('thead', {}, E('tr', {}, headings.map(function(h) { return E('th', {scope: 'col'}, h); }))), E('tbody', {}, rows.length ? rows.map(function(row) { return E('tr', {}, row.map(function(v) { return E('td', {}, v == null ? '—' : typeof v === 'number' ? String(v) : v); })); }) : [E('tr', {}, E('td', {colspan: headings.length, 'class': 'if-empty'}, query ? 'No matching interfaces.' : active === 'VLAN' ? 'No VLAN devices configured. Add a VLAN to get started.' : 'No interfaces found.'))]) ]));
            table.querySelectorAll('button').forEach(function(b) { b.disabled = readonly || busy || failed || submitted; });
        }
        function draw() {
            Array.from(tabbar.children).forEach(function(b, i) { b.setAttribute('aria-selected', String(tabs[i] === active)); b.setAttribute('tabindex', tabs[i] === active ? '0' : '-1'); });
            panel.setAttribute('aria-labelledby', 'if-tab-' + tabs.indexOf(active));
            var controls = [];
            if (active === 'VLAN') { var add = button('+ Add VLAN', function() { editVLAN(); }, true); add.disabled = readonly || busy || failed || submitted; controls.push(add); }
            controls.push(advanced(active === 'Interface List' ? 'Configure networks' : 'OpenWrt device settings'), search);
            toolbar.replaceChildren.apply(toolbar, controls);
            note.textContent = active === 'VLAN' ? 'VLANs carry tagged traffic. After adding one, assign it to a network in Interface List → Configure networks. Configure bridge access/trunk port membership in Bridge / VLAN.' : active === 'Interface List' ? 'OpenWrt logical networks and their assigned devices. Configure IP addresses, protocols and device assignments using Configure networks.' : active === 'Ethernet' ? 'Edit port MTU and MAC address. Empty MTU uses 1500; clearing a MAC override takes effect after a device restart. Link speed is reported by the driver.' : 'Live device status and traffic. Tx / Rx show measured rates; packet columns show totals since the device started.';
            var count = edits().length, apply = button(busy ? 'Applying…' : 'Review & apply', review, true), discard = button('Discard edits', function() { draft = clone(baseline); draw(); });
            apply.disabled = !count || readonly || busy || failed || submitted; discard.disabled = !count || busy || failed || submitted;
            footer.replaceChildren(E('span', {role: 'status'}, failed ? 'Reload required · review OpenWrt pending changes' : submitted ? 'Changes saved · complete the OpenWrt apply dialog, or reload to review pending changes' : readonly ? 'Read-only access' : count ? count + ' device change' + (count === 1 ? '' : 's') + ' to review' : 'No pending edits'), discard, apply);
            drawTable();
        }
        function sample(next) {
            var now = Date.now();
            Object.keys(next).forEach(function(n) { var p = (previous[n] || {}).statistics || {}, c = next[n].statistics || {}; rates[n] = {tx: data.rate(p.tx_bytes, c.tx_bytes, (now - previousTime) / 1000), rx: data.rate(p.rx_bytes, c.rx_bytes, (now - previousTime) / 1000)}; });
            previous = next; previousTime = now; live = next;
        }
        sample(live); draw();
        poll.add(function() {
            return Promise.all([dump(), status()]).then(function(values) { states = values[0]; sample(values[1]); health.textContent = 'Live · updated ' + new Date().toLocaleTimeString(); drawTable(); }).catch(function() { health.textContent = 'Connection lost · showing last received values'; });
        }, 5);
        window.addEventListener('beforeunload', function(e) { if (edits().length && !busy && !failed && !submitted && !applied) { e.preventDefault(); e.returnValue = ''; } });
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
