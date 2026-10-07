'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require poll';
'require freeisp.firewall-data as data';
'require freeisp.firewall-runtime as runtime';

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function text(value) { return Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value); }
function button(label, click, primary) { return E('button', {type: 'button', 'class': 'fw-button' + (primary ? ' fw-primary' : ''), click: click}, label); }
function link(label, path) { return E('a', {'class': 'fw-button', href: L.url.apply(L, ['admin'].concat(path))}, label); }

return view.extend({
    load: function() { return Promise.all([uci.load('firewall'), runtime.load()]); },
    render: function(result) {
        var self = this, baseline = copy(uci.sections('firewall')), draft = copy(baseline), live = result[1];
        var active = 'Filter Rules', selected = null, serial = 0, busy = false, failed = false, submitted = false, refreshing = false;
        var readonly = !L.hasViewPermission(), showLive = false;
        var tabs = ['Filter Rules', 'NAT', 'Mangle', 'Raw', 'Service Ports', 'Connections', 'Address Lists', 'Layer7 Protocols'];
        function edits() { return data.operations(baseline, draft); }
        function locked() { return readonly || busy || failed || submitted; }
        function notify(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        function chosen() { return draft.filter(function(s) { return s['.name'] === selected; })[0]; }
        function current() { return draft.filter(function(s) { return data.tabFor(s) === active; }); }
        function kind(s) {
            if (s['.type'] === 'redirect') return 'dnat';
            if (s['.type'] === 'nat') return 'snat';
            if (s['.type'] === 'ipset') return 'ipset';
            return {Mangle: 'mangle', Raw: 'raw', 'Service Ports': 'helper'}[data.tabFor(s)] || 'filter';
        }
        function zoneChoices(device, wildcard) {
            var choices = device ? [['', 'This device']] : [['', 'Choose zone']];
            if (wildcard) choices.push(['*', 'Any zone']);
            return choices.concat(draft.filter(function(s) { return s['.type'] === 'zone'; }).map(function(s) { return [s.name, s.name]; }));
        }
        function edit(section, newKind) {
            if (locked()) return;
            var s = section || {}, type = section ? kind(section) : newKind, fields = {}, containers = {}, specs = [];
            function field(key, label, options, placeholder, fallback) { specs.push({key: key, label: label, options: options, placeholder: placeholder, value: s[key] == null ? fallback || '' : text(s[key])}); }
            field('name', type === 'ipset' ? 'List name' : 'Name / comment', null, type === 'ipset' ? 'trusted_clients' : 'Describe this rule');
            if (type !== 'ipset') field('enabled', 'Status', [['0', 'Disabled'], ['1', 'Enabled']], null, section ? '1' : '0');
            field('family', 'Address family', type === 'ipset' ? [['ipv4', 'IPv4'], ['ipv6', 'IPv6']] : [['any', 'IPv4 and IPv6'], ['ipv4', 'IPv4'], ['ipv6', 'IPv6']], null, /^(dnat|snat|ipset)$/.test(type) ? 'ipv4' : 'any');
            if (type === 'ipset') {
                field('match', 'Match addresses', [['src_ip', 'Source address'], ['dest_ip', 'Destination address']], null, 'src_ip');
                field('entry', 'Addresses', null, 'One IP address or subnet per line');
                specs[specs.length - 1].value = data.list(s.entry).join('\n');
                specs[specs.length - 1].multiline = true;
            } else {
                if (type === 'filter') field('target', 'Action', [['ACCEPT', 'Accept'], ['DROP', 'Drop'], ['REJECT', 'Reject']], null, 'ACCEPT');
                if (type === 'mangle') { field('target', 'Action', [['MARK', 'Set packet mark'], ['DSCP', 'Set DSCP']], null, 'MARK'); field('set_mark', 'Packet mark', null, '0x1 or 0x1/0xff'); field('set_dscp', 'DSCP value', null, '0–63, EF, AF41 or CS1'); }
                if (type === 'raw') field('target', 'Action', [['NOTRACK', 'Do not track']], null, 'NOTRACK');
                if (type === 'helper') {
                    field('target', 'Action', [['HELPER', 'Assign connection helper']], null, 'HELPER');
                    field('set_helper', 'Helper', [['', 'Choose an installed helper']].concat((live.helpers || []).filter(function(h) { return h.available; }).map(function(h) { return [h.name, h.name + (h.description ? ' · ' + h.description : '')]; })));
                }
                if (type === 'snat') field('target', 'Action', [['SNAT', 'Source NAT'], ['MASQUERADE', 'Masquerade']], null, 'SNAT');
                field('src', type === 'snat' ? 'Outgoing zone' : 'Source zone', zoneChoices(!/^(raw|helper|dnat|snat)$/.test(type), !/^(raw|helper|dnat)$/.test(type)), null, /^(dnat|snat)$/.test(type) ? 'wan' : 'lan');
                if (!/^(raw|helper|snat)$/.test(type)) field('dest', 'Destination zone', zoneChoices(true, true), null, type === 'dnat' ? 'lan' : '');
                field('proto', 'Protocol', [['all', 'Any protocol'], ['tcp', 'TCP'], ['udp', 'UDP'], ['tcp udp', 'TCP + UDP'], ['icmp', 'ICMP'], ['ipv6-icmp', 'ICMPv6']], null, /^(dnat|helper)$/.test(type) ? 'tcp' : 'all');
                field('src_ip', 'Source address', null, 'Any · or IP / subnet');
                if (type !== 'dnat') field('dest_ip', 'Destination address', null, 'Any · or IP / subnet');
                field('src_port', 'Source ports', null, 'Any · e.g. 1024-65535');
                field('dest_port', type === 'dnat' ? 'Internal port' : 'Destination ports', null, type === 'dnat' ? 'Keep original port' : 'Any · e.g. 80 443');
                if (type === 'dnat') {
                    field('src_dip', 'External address', null, 'Any address on the source zone');
                    field('src_dport', 'External ports', null, 'e.g. 8080');
                    field('dest_ip', 'Internal address', null, 'e.g. 10.77.0.10');
                    field('reflection', 'NAT loopback', [['1', 'Enabled'], ['0', 'Disabled']], null, '1');
                }
                if (type === 'snat') { field('snat_ip', 'Translated address', null, 'e.g. 203.0.113.10'); field('snat_port', 'Translated ports', null, 'Keep original ports'); }
                if (type === 'filter' || type === 'mangle') field('ipset', 'Address list', [['', 'Any address']].concat(draft.filter(function(d) { return d['.type'] === 'ipset'; }).map(function(d) { return [d.name, d.name]; })));
            }
            var notice = E('p', {'class': 'fw-error', role: 'alert'});
            var rows = specs.map(function(spec) {
                var id = 'fw-edit-' + spec.key, options = spec.options && spec.options.slice();
                // Existing advanced values must not silently change when opened.
                if (options && !options.some(function(o) { return o[0] === spec.value; })) options.push([spec.value, spec.value + ' (existing)']);
                var control = options ? E('select', {id: id}, options.map(function(o) { return E('option', {value: o[0]}, o[1]); })) : E(spec.multiline ? 'textarea' : 'input', {id: id, type: spec.multiline ? null : 'text', rows: spec.multiline ? '5' : null, placeholder: spec.placeholder || ''});
                control.value = spec.value; fields[spec.key] = control;
                containers[spec.key] = E('div', {'class': 'fw-field'}, [E('label', {'for': id}, spec.label), control]);
                return containers[spec.key];
            });
            function dependentFields() {
                [['set_mark', 'MARK'], ['set_dscp', 'DSCP'], ['snat_ip', 'SNAT'], ['snat_port', 'SNAT']].forEach(function(pair) {
                    if (fields[pair[0]]) { fields[pair[0]].disabled = fields.target.value !== pair[1]; containers[pair[0]].hidden = fields[pair[0]].disabled; }
                });
            }
            if (fields.target) fields.target.addEventListener('change', dependentFields);
            dependentFields();
            var save = button('Save to review', function() {
                try {
                    var values = {};
                    Object.keys(fields).forEach(function(k) { values[k] = fields[k].disabled ? '' : fields[k].value.trim(); });
                    if (type === 'dnat') values.target = 'DNAT';
                    if (type === 'helper' && !live.helpers.some(function(h) { return h.name === values.set_helper && h.available; })) throw new Error('This connection helper is not installed. Install its OpenWrt kernel module before assigning it.');
                    var valid = data.validate(values, type, draft, section);
                    if (section) Object.assign(section, valid);
                    else draft.push(Object.assign({'.name': 'freeisp_draft_' + (++serial), '.type': type === 'ipset' ? 'ipset' : type === 'dnat' ? 'redirect' : type === 'snat' ? 'nat' : 'rule'}, valid));
                    ui.hideModal(); draw();
                } catch(e) { notice.textContent = e.message || String(e); }
            }, true);
            ui.showModal((section ? 'Edit ' : 'Add ') + ({filter: 'filter rule', dnat: 'port forward', snat: 'source NAT', mangle: 'mangle rule', raw: 'raw rule', helper: 'helper assignment', ipset: 'address list'}[type]), [
                E('div', {'class': 'fw-editor'}, [E('p', {'class': 'fw-muted'}, type === 'ipset' ? 'Lists match addresses only when a rule references them.' : 'Changes stay on this page until Review & apply. New rules start disabled.'), E('div', {'class': 'fw-fields'}, rows), notice]),
                E('div', {'class': 'fw-modal-actions'}, [link('Advanced settings', ['network', 'firewall', type === 'dnat' ? 'forwards' : type === 'snat' ? 'snats' : type === 'ipset' ? 'ipsets' : 'rules']), button('Cancel', ui.hideModal), save])
            ]);
            fields.name.focus();
        }
        function remove() {
            var s = chosen(); if (!s || locked()) return;
            ui.showModal('Remove firewall entry', [E('p', {}, 'Remove “' + (s.name || s['.name']) + '”? Removal takes effect only after Review & apply.'), E('div', {'class': 'fw-modal-actions'}, [button('Cancel', ui.hideModal), button('Remove entry', function() {
                var next = draft.filter(function(d) { return d !== s; });
                try { if (data.validateDraft) data.validateDraft(baseline, next); draft = next; selected = null; ui.hideModal(); draw(); } catch(e) { notify(e); }
            }, true)])]);
        }
        function move(direction) {
            if (locked()) return;
            var entries = current(), index = entries.indexOf(chosen()), neighbor = entries[index + direction];
            if (!neighbor) return;
            var a = draft.indexOf(chosen()), b = draft.indexOf(neighbor), s = draft[a];
            draft.splice(a, 1); draft.splice(b, 0, s); draw();
        }
        function review() {
            if (locked() || !edits().length) return;
            try { if (data.validateDraft) data.validateDraft(baseline, draft); } catch(e) { notify(e); return; }
            var ops = edits();
            ui.showModal('Review firewall changes', [
                E('p', {}, 'These changes can affect router access and traffic. OpenWrt will apply them with automatic rollback if connectivity cannot be confirmed.'),
                E('div', {'class': 'fw-review'}, ops.map(function(op) { return E('p', {}, describe(op)); })),
                E('p', {'class': 'fw-muted'}, 'Existing tracked connections may keep their previous NAT or filtering decision. Test changes with new connections.'),
                E('div', {'class': 'fw-modal-actions'}, [button('Cancel', ui.hideModal), button('Apply changes', function() { ui.hideModal(); self.applyEdits(ops); }, true)])
            ]);
        }
        function describe(op) {
            var s = op.section || {}, action = op.kind || op.type || 'Update';
            return action + ' · ' + (s.name || s['.name'] || op.sid || 'rule order') + (op.values ? ': ' + Object.keys(op.values).map(function(k) { return k + ' = ' + (text(op.values[k]) || 'default'); }).join(', ') : '');
        }
        self.applyEdits = async function(ops) {
            if (locked()) return;
            busy = true; draw(); var staged = false;
            try {
                var pending = await uci.changes();
                if (Object.keys(pending).some(function(k) { return pending[k].length; })) throw new Error('There are already pending OpenWrt changes. Apply or revert them before applying this page.');
                uci.unload('firewall'); await uci.load('firewall');
                if (JSON.stringify(uci.sections('firewall')) !== JSON.stringify(baseline)) throw new Error('Firewall settings have changed since this page loaded. Reload and review your edits against the latest settings.');
                staged = true; data.stage(uci, ops); await uci.save(); await ui.changes.init();
                document.addEventListener('uci-applied', function() { window.location.reload(); }, {once: true});
                await ui.changes.apply(true); submitted = true;
            } catch(e) {
                if (staged) { failed = true; notify(new Error('Saving or applying did not finish. Review OpenWrt pending changes and reload before retrying. ' + (e.message || e))); }
                else notify(e);
            } finally { busy = false; draw(); }
        };
        var tabbar = E('div', {'class': 'fw-tabs', role: 'tablist', 'aria-label': 'Firewall sections'});
        tabs.forEach(function(t, i) {
            var b = button(t, function() { active = t; selected = null; showLive = false; search.value = ''; draw(); });
            b.setAttribute('role', 'tab'); b.id = 'fw-tab-' + i; b.setAttribute('aria-controls', 'fw-panel');
            b.addEventListener('keydown', function(e) {
                var next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
                if (next !== -1) { e.preventDefault(); active = tabs[next]; selected = null; showLive = false; search.value = ''; draw(); tabbar.children[next].focus(); }
            }); tabbar.appendChild(b);
        });
        var search = E('input', {type: 'search', placeholder: 'Find a rule or address…', 'aria-label': 'Search firewall', input: function() { drawTable(); }});
        var toolbar = E('div', {'class': 'fw-toolbar'}), table = E('div', {'class': 'fw-table-wrap'}), help = E('p', {'class': 'fw-help'}), footer = E('div', {'class': 'fw-footer'});
        var health = E('span', {'class': 'fw-health', role: 'status'}), summary = E('div', {'class': 'fw-summary'});
        var panel = E('section', {id: 'fw-panel', role: 'tabpanel'}, [toolbar, table, help]);
        var root = E('div', {'class': 'fw-window'}, [E('link', {rel: 'stylesheet', href: L.resource('freeisp/firewall.css') + '?v=1'}),
            E('div', {'class': 'fw-heading'}, [E('div', {}, [E('h2', {}, 'Firewall'), E('p', {}, 'Traffic rules, address translation and live connections.')]), health]), summary,
            E('div', {'class': 'fw-card'}, [tabbar, panel, footer])]);
        function status(s) { return E('span', {'class': 'fw-badge' + (s.enabled === '0' ? ' is-disabled' : '')}, s.enabled === '0' ? 'Disabled' : 'Enabled'); }
        function value(v) { return text(v) || '—'; }
        function counters(s) {
            if (live.stale || edits().length || s.enabled === '0' || !s.name || (live.errors || []).some(function(e) { return /nft|rules|counter/i.test(text(e)); })) return ['—', '—'];
            if (baseline.filter(function(d) { return d.name === s.name; }).length !== 1) return ['—', '—'];
            var matched = (live.rules || []).filter(function(r) { return r.comment === '!fw4: ' + s.name; });
            // Rules can compile into several chains or families. Only display
            // unambiguous single-rule counters here; all counters remain in Live rules.
            return matched.length === 1 && matched[0].packets != null ? [value(matched[0].bytes), value(matched[0].packets)] : ['—', '—'];
        }
        function drawTable() {
            var headings, rows = [], query = search.value.toLowerCase(), empty = 'No entries configured. Use Add to create one.';
            if (active === 'Layer7 Protocols') {
                table.replaceChildren(E('div', {'class': 'fw-unavailable'}, [E('h3', {}, 'Layer7 regular expressions are not supported'), E('p', {}, 'This OpenWrt build does not provide RouterOS Layer7 protocol matching. Encrypted HTTPS content cannot be reliably matched by a payload regular expression.'), E('p', {}, 'Use address lists and IP / port rules for known endpoints. DNS or application filtering needs a separate service with its own configuration.'), link('Open traffic rules', ['network', 'firewall', 'rules'])])); return;
            }
            if (showLive) {
                headings = ['Chain', 'Comment', 'Expression', 'Bytes', 'Packets'];
                rows = (live.rules || []).map(function(r) { return {cells: [value(r.chain), value(r.comment), value(r.expression), value(r.bytes), value(r.packets)]}; });
                empty = 'No live rules received. Check the status message above.';
            } else if (active === 'Connections') {
                headings = ['Protocol', 'Source', 'Destination', 'Reply source', 'Reply destination', 'State', 'Expires', 'Bytes'];
                rows = (live.connections || []).map(function(c) { return {cells: [value(c.protocol), value(c.source), value(c.destination), value(c.replySource), value(c.replyDestination), value(c.state), value(c.expires), value(c.bytes)]}; });
                empty = 'No tracked connections received. Untracked and offloaded traffic may not appear here.';
            } else {
                headings = active === 'Address Lists' ? ['List', 'Family', 'Match', 'Addresses'] : ['#', 'Status', 'Action', 'Name / comment', 'Source', 'Destination', 'Protocol', 'Source ports', 'Destination ports', 'Bytes', 'Packets'];
                rows = current().map(function(s, i) {
                    var stats = counters(s), source = value(s.src), destination = value(s.dest);
                    if (s['.type'] === 'rule') { source = (s.src || 'This device') + (s.src_ip ? ' · ' + value(s.src_ip) : ''); destination = (s.dest || 'This device') + (s.dest_ip ? ' · ' + value(s.dest_ip) : ''); }
                    else if (s['.type'] === 'redirect') { source += ' · ' + (s.src_dip || 'any address'); destination += ' · ' + value(s.dest_ip); }
                    else if (s['.type'] === 'nat') { source = 'Out: ' + (s.src || 'Any'); destination = (s.target || 'SNAT') + ' · ' + (s.snat_ip || 'interface address'); }
                    var action = (s.target || (s['.type'] === 'redirect' ? 'DNAT' : '—')) + (s.set_mark ? ' ' + s.set_mark : s.set_dscp ? ' ' + s.set_dscp : s.set_helper ? ' ' + s.set_helper : '');
                    return {sid: s['.name'], cells: active === 'Address Lists' ? [value(s.name), value(s.family || 'ipv4'), value(s.match), data.list(s.entry).join(', ') || 'No static addresses'] : [String(i + 1), status(s), action, s.name || s['.name'], source, destination, value(s.proto || 'tcp udp'), value(s.src_port), value(s['.type'] === 'redirect' ? s.src_dport : s.dest_port), stats[0], stats[1]]};
                });
            }
            rows = rows.filter(function(row) { return row.cells.some(function(cell) { return (cell instanceof Node ? cell.textContent : String(cell)).toLowerCase().indexOf(query) !== -1; }); });
            table.replaceChildren(E('table', {'class': 'fw-table', 'aria-label': showLive ? 'Live firewall rules' : active}, [E('thead', {}, E('tr', {}, headings.map(function(h) { return E('th', {scope: 'col'}, h); }))), E('tbody', {}, rows.length ? rows.map(function(row) {
                var attrs = row.sid ? {tabindex: '0', 'class': row.sid === selected ? 'is-selected' : '', 'aria-label': 'Select ' + (draft.filter(function(s) { return s['.name'] === row.sid; })[0].name || row.sid), click: function() { selected = row.sid; drawControls(); drawTable(); }, keydown: function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = row.sid; drawControls(); drawTable(); table.querySelector('.is-selected').focus(); } }} : {};
                return E('tr', attrs, row.cells.map(function(c) { return E('td', {}, c); }));
            }) : E('tr', {}, E('td', {colspan: headings.length, 'class': 'fw-empty'}, query ? 'No matching entries.' : empty)))]));
        }
        function drawControls() {
            var controls = [], s = chosen(), editable = active !== 'Connections' && active !== 'Layer7 Protocols' && !showLive;
            function action(label, fn, disabled, primary) { var b = button(label, fn, primary); b.disabled = !!disabled; controls.push(b); }
            if (editable) {
                var map = {'Filter Rules': 'filter', NAT: 'dnat', Mangle: 'mangle', Raw: 'raw', 'Service Ports': 'helper', 'Address Lists': 'ipset'};
                action(active === 'NAT' ? '+ Port forward' : '+ Add', function() { edit(null, map[active]); }, locked() || active === 'Service Ports' && !(live.helpers || []).some(function(h) { return h.available; }), true);
                if (active === 'NAT') action('+ Source NAT', function() { edit(null, 'snat'); }, locked());
                action('Edit', function() { if (s) edit(s); }, locked() || !s);
                action('Remove', remove, locked() || !s);
                if (active !== 'Address Lists') {
                    action(s && s.enabled === '0' ? 'Enable' : 'Disable', function() { s.enabled = s.enabled === '0' ? '1' : '0'; draw(); }, locked() || !s);
                    var index = current().indexOf(s);
                    action('Move up', function() { move(-1); }, locked() || !s || index === 0);
                    action('Move down', function() { move(1); }, locked() || !s || index === current().length - 1);
                }
            }
            if (active !== 'Layer7 Protocols') {
                action(refreshing ? 'Refreshing…' : 'Refresh', refresh, refreshing);
                if (active !== 'Connections' && active !== 'Address Lists') action(showLive ? 'Configured rules' : 'Live rules & counters', function() { showLive = !showLive; selected = null; draw(); }, false);
                controls.push(search);
            }
            toolbar.replaceChildren.apply(toolbar, controls);
        }
        function draw() {
            Array.from(tabbar.children).forEach(function(b, i) { b.setAttribute('aria-selected', String(tabs[i] === active)); b.setAttribute('tabindex', tabs[i] === active ? '0' : '-1'); });
            panel.setAttribute('aria-labelledby', 'fw-tab-' + tabs.indexOf(active));
            var errors = live.errors || [];
            health.textContent = errors.length ? 'Live data incomplete · ' + errors.map(text).join(' · ') : 'Live data · refreshes every 10 seconds';
            health.classList.toggle('has-error', !!errors.length);
            summary.replaceChildren(E('span', {}, baseline.filter(function(s) { return s['.type'] === 'rule'; }).length + ' traffic rules'), E('span', {}, baseline.filter(function(s) { return /^(redirect|nat)$/.test(s['.type']); }).length + ' NAT entries'), E('span', {}, (live.connections || []).length + ' tracked connections'), link('Zones & default policies', ['network', 'firewall', 'zones']));
            drawControls(); drawTable();
            var notes = {'Filter Rules': 'Source zone → This device is input; This device → destination zone is output; two zones mean forwarded traffic. OpenWrt also applies zone policies and generated rules. Live rules shows the complete running fw4 table.', NAT: 'Port forwards use destination NAT; source NAT and masquerading use the outgoing zone. LAN masquerading and zone policies are under Zones & default policies. NAT applies to new connections.', Mangle: 'Set packet marks or DSCP values. Packet marks need a matching routing or queue policy to change traffic handling.', Raw: 'NOTRACK bypasses connection tracking before filtering. Untracked traffic cannot use stateful NAT; restrict the source and destination carefully.', 'Service Ports': 'Assign installed connection tracking helpers to narrowly matched traffic. These are protocol helpers, not router management service ports. Global automatic assignment is configured in zone settings.', Connections: 'Read-only connection tracking snapshot. Source and reply directions expose NAT translations. Accounting may be unavailable or incomplete for offloaded traffic.', 'Address Lists': 'Persistent IP sets for source or destination address matching. Reference a list in a filter or mangle rule to use it. Advanced tuple sets and dynamic feeds remain in OpenWrt IP Sets.', 'Layer7 Protocols': 'RouterOS Layer7 rules are not portable to OpenWrt firewall4.'};
            help.textContent = showLive ? 'Read-only kernel snapshot, including generated zone rules. Counters are reported only when present; — means unavailable. Counters can restart when the firewall reloads. No counter reset is performed.' : notes[active];
            var count = edits().length, apply = button(busy ? 'Applying…' : 'Review & apply', review, true), discard = button('Discard edits', function() { draft = copy(baseline); selected = null; draw(); });
            apply.disabled = !count || locked(); discard.disabled = !count || busy || failed || submitted;
            footer.replaceChildren(E('span', {role: 'status'}, failed ? 'Reload required · review OpenWrt pending changes' : submitted ? 'Changes saved · complete the OpenWrt apply dialog' : readonly ? 'Read-only access' : count ? count + ' pending change' + (count === 1 ? '' : 's') : 'No pending edits'), discard, apply);
        }
        function refresh() {
            if (refreshing) return Promise.resolve(); refreshing = true; drawControls();
            return runtime.load().then(function(next) { live = next; }).catch(function(e) { live.stale = true; live.errors = ['Refresh failed; showing last received data. ' + (e.message || e)]; }).finally(function() { refreshing = false; draw(); });
        }
        poll.add(refresh, 10); draw();
        window.addEventListener('beforeunload', function(e) { if (edits().length && !busy && !failed && !submitted) { e.preventDefault(); e.returnValue = ''; } });
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
