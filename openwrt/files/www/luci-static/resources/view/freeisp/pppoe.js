'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var get = rpc.declare({object: 'freeisp.pppoe', method: 'get', expect: {'': {}}, reject: true});
var status = rpc.declare({object: 'freeisp.pppoe', method: 'status', expect: {'': {}}, reject: true});
var save = rpc.declare({object: 'freeisp.pppoe', method: 'save', params: ['config', 'revision'], expect: {'': {}}, reject: true});
var disconnect = rpc.declare({object: 'freeisp.pppoe', method: 'disconnect', params: ['id'], expect: {'': {}}, reject: true});
function checked(value) { if (value.error) { var e = new Error(value.error); e.known = true; throw e; } return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function identifier() { var values = new Uint8Array(6); window.crypto.getRandomValues(values); return Array.from(values, function(n) { return n.toString(16).padStart(2, '0'); }).join(''); }

return view.extend({
    // Render controls first. A slow router must not hide the entire page.
    load: function() { return Promise.resolve(null); },
    render: function(initial) {
        var stylesheet = E('link', {rel: 'stylesheet', href: L.resource('freeisp/pppoe.css') + '?v=2'});
        var loaded = !!(initial && initial.config), loadError = '', loadingConfig = false;
        initial = initial || {config: {servers: [], secrets: [], profiles: [], pools: []}, interfaces: [], status: {servers: [], sessions: []}};
        var baseline = clone(initial.config), draft = clone(baseline), revision = initial.revision, live = initial.status;
        var devices = initial.interfaces, active = 'servers', busy = false, uncertain = false, connected = loaded;
        var readonly = !L.hasViewPermission();
        var sections = [['servers', 'PPPoE Servers'], ['secrets', 'Secrets'], ['profiles', 'Profiles'], ['pools', 'Address Pools'], ['active', 'Active Connections']];
        function button(label, handler, primary) { return E('button', {type: 'button', 'class': 'pp-button' + (primary ? ' pp-primary' : ''), click: handler}, label); }
        function notify(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        function changed() { return JSON.stringify(baseline) !== JSON.stringify(draft); }
        function label(kind, id) { return (draft[kind].find(function(r) { return r.id === id; }) || {}).name || '—'; }
        function options(kind, empty) { return (empty ? [['', empty]] : [['', 'Select…']]).concat(draft[kind].map(function(r) { return [r.id, r.name]; })); }
        function editable() { return loaded && !readonly && !busy && !uncertain; }
        function editor(kind, row) {
            var record = clone(row || {id: identifier(), enabled: true}), fields = {}, specs;
            var defaultProfile = draft.profiles.find(function(p) { return p.name === 'default'; }) || draft.profiles[0];
            if (!row && defaultProfile) {
                if (kind === 'servers') record.profile = defaultProfile.id;
                if (kind === 'profiles') ['pool', 'local_ip', 'dns1', 'dns2', 'download', 'upload'].forEach(function(key) { record[key] = defaultProfile[key]; });
            }
            var common = [{key: 'name', label: kind === 'secrets' ? 'Username' : kind === 'servers' ? 'Service name' : 'Name', required: true}];
            if (kind === 'pools') specs = common.concat([
                {key: 'start', label: 'First address', placeholder: '10.80.0.10', required: true},
                {key: 'end', label: 'Last address', placeholder: '10.80.0.254', required: true}
            ]);
            if (kind === 'profiles') specs = common.concat([
                {key: 'local_ip', label: 'Local address', placeholder: '10.80.0.1', required: true},
                {key: 'pool', label: 'Remote address pool', options: options('pools'), required: true},
                {key: 'dns1', label: 'Primary DNS', placeholder: '1.1.1.1'}, {key: 'dns2', label: 'Secondary DNS', placeholder: '8.8.8.8'},
                {key: 'download', label: 'Download · kbit/s', type: 'number', value: 0, min: 0, max: 10000000},
                {key: 'upload', label: 'Upload · kbit/s', type: 'number', value: 0, min: 0, max: 10000000}
            ]);
            if (kind === 'servers') specs = common.concat([
                {key: 'interface', label: 'Interface', options: [['', 'Select…']].concat(devices.map(function(d) { return [d.name, d.name + (d.up ? '' : ' · down')]; })), required: true},
                {key: 'profile', label: 'Default profile', options: options('profiles'), required: true},
                {key: 'mtu', label: 'MTU / MRU', type: 'number', value: 1492, min: 576, max: 1492},
                {key: 'max_sessions', label: 'Maximum sessions', type: 'number', value: 256, min: 1, max: 4096},
                {key: 'enabled', label: 'Enabled', type: 'checkbox'}
            ]);
            if (kind === 'secrets') specs = common.concat([
                {key: 'password', label: 'Password', type: 'password', required: !record.has_password && !record.password, placeholder: record.has_password ? 'Leave blank to keep existing password' : ''},
                {key: 'server', label: 'PPPoE server', options: options('servers'), required: true},
                {key: 'profile', label: 'Profile', options: options('profiles', 'Use server default')},
                {key: 'remote_ip', label: 'Remote address', placeholder: 'Automatic reservation from profile pool'},
                {key: 'enabled', label: 'Enabled', type: 'checkbox'}
            ]);
            var error = E('p', {'class': 'pp-error', role: 'alert'});
            var form = E('form', {'class': 'pp-editor', submit: function(e) {
                e.preventDefault();
                try {
                    specs.forEach(function(s) {
                        var field = fields[s.key];
                        record[s.key] = s.type === 'checkbox' ? field.checked : s.type === 'number' ? Number(field.value) : s.type === 'password' ? field.value : field.value.trim();
                        if (s.required && !record[s.key]) throw new Error(s.label + ' is required.');
                    });
                    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@ -]{0,63}$/.test(record.name)) throw new Error('Name must start with a letter, number or underscore and contain 1–64 valid characters.');
                    if (kind === 'pools') delete record.enabled;
                    if (kind === 'profiles') delete record.enabled;
                    var index = draft[kind].findIndex(function(r) { return r.id === record.id; });
                    if (index < 0) draft[kind].push(record); else draft[kind][index] = record;
                    ui.hideModal(); draw();
                } catch(e) { error.textContent = e.message; }
            }}, specs.map(function(s) {
                var id = 'pp-field-' + s.key;
                var control = s.options ? E('select', {id: id, required: !!s.required}, s.options.map(function(o) { return E('option', {value: o[0]}, o[1]); })) : E('input', {id: id, type: s.type || 'text', required: !!s.required, placeholder: s.placeholder || '', autocomplete: s.type === 'password' ? 'new-password' : 'off'});
                // LuCI's DOM helper stringifies false attributes. Set the native
                // boolean property so optional fields do not become required.
                control.required = !!s.required;
                if (s.type === 'checkbox') control.checked = record[s.key] !== false;
                else control.value = record[s.key] == null ? (s.value == null ? '' : s.value) : record[s.key];
                if (s.type === 'number') { control.min = s.min; control.max = s.max; control.step = 1; }
                fields[s.key] = control;
                return E('div', {'class': 'pp-field'}, [E('label', {'for': id}, s.label), control]);
            }));
            form.appendChild(error);
            form.appendChild(E('p', {'class': 'pp-muted'}, kind === 'profiles' ? '0 means unlimited. Each account reserves one address from its pool and permits one connection at a time.' : 'Changes stay on this page until you save and apply.'));
            var submit = E('button', {type: 'submit', 'class': 'pp-button pp-primary'}, 'Save to review');
            form.appendChild(E('div', {'class': 'pp-actions'}, [button('Cancel', ui.hideModal), submit]));
            ui.showModal((row ? 'Edit ' : 'Add ') + ({servers: 'PPPoE server', secrets: 'secret', profiles: 'profile', pools: 'address pool'}[kind]), [form]);
            fields.name.focus();
        }
        function remove(kind, row) {
            var referenced = kind === 'pools' ? draft.profiles.some(function(p) { return p.pool === row.id; }) : kind === 'profiles' ? draft.servers.some(function(s) { return s.profile === row.id; }) || draft.secrets.some(function(s) { return s.profile === row.id; }) : kind === 'servers' ? draft.secrets.some(function(s) { return s.server === row.id; }) : false;
            if (referenced) { notify(new Error('This ' + kind.slice(0, -1) + ' is still in use. Reassign or remove its dependent records first.')); return; }
            ui.showModal('Remove ' + row.name, [E('p', {}, 'Remove this record from your pending settings?'), E('div', {'class': 'pp-actions'}, [button('Cancel', ui.hideModal), button('Remove', function() { draft[kind] = draft[kind].filter(function(r) { return r.id !== row.id; }); ui.hideModal(); draw(); }, true)])]);
        }
        function rowActions(kind, row) { return E('div', {'class': 'pp-actions'}, [button('Edit', function() { editor(kind, row); }), button('Remove', function() { remove(kind, row); })]); }
        function confirmApply() {
            ui.showModal('Apply PPPoE settings', [E('p', {}, 'Applying restarts PPPoE servers and disconnects current subscriber sessions. Clients can reconnect using the updated settings.'), E('p', {}, 'The router validates all pools, references and accounts before saving. If a server fails to start, it restores the previous settings.'), E('div', {'class': 'pp-actions'}, [button('Cancel', ui.hideModal), button('Save & apply', async function() {
                ui.hideModal(); busy = true; draw();
                try {
                    var result = checked(await save(draft, revision));
                    baseline = clone(result.config); draft = clone(baseline); revision = result.revision; live = result.status; connected = true;
                    ui.addNotification(null, E('p', {}, 'PPPoE settings saved and applied.'), 'info');
                } catch(e) { if (!e.known) { uncertain = true; connected = false; } notify(e.known ? e : new Error('Connection lost while saving. Reload to confirm the router’s saved settings before retrying.')); }
                finally { busy = false; draw(); }
            }, true)])]);
        }
        var tabs = E('div', {'class': 'pp-tabs', role: 'tablist', 'aria-label': 'PPPoE sections'});
        sections.forEach(function(section, index) {
            var tab = button(section[1], function() { active = section[0]; search.value = ''; draw(); });
            tab.id = 'pp-tab-' + section[0]; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'pp-panel');
            tab.addEventListener('keydown', function(e) {
                var next = e.key === 'ArrowRight' ? (index + 1) % sections.length : e.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : e.key === 'Home' ? 0 : e.key === 'End' ? sections.length - 1 : -1;
                if (next >= 0) { e.preventDefault(); active = sections[next][0]; search.value = ''; draw(); tabs.children[next].focus(); }
            }); tabs.appendChild(tab);
        });
        var search = E('input', {type: 'search', placeholder: 'Find…', 'aria-label': 'Find a PPPoE record', input: function() { drawTable(); }});
        var toolbar = E('div', {'class': 'pp-toolbar'}), table = E('div', {'class': 'pp-table-wrap'}), footer = E('div', {'class': 'pp-footer'});
        var health = E('span', {'class': 'pp-muted', role: 'status'});
        var note = E('p', {'class': 'pp-help'});
        var panel = E('section', {id: 'pp-panel', role: 'tabpanel'}, [toolbar, table, note]);
        var root = E('div', {'class': 'pp-window'}, [stylesheet, E('div', {'class': 'pp-heading'}, [E('div', {}, [E('h2', {}, 'PPPoE'), E('p', {}, 'Servers, subscriber accounts, profiles and address pools.')]), health]), E('div', {'class': 'pp-card'}, [tabs, panel, footer])]);
        function drawTable() {
            var columns, rows, query = search.value.toLowerCase();
            if (active === 'servers') {
                columns = ['Service name', 'Interface', 'Default profile', 'MTU', 'Max sessions', 'Status', 'Actions'];
                rows = draft.servers.map(function(r) { var s = live.servers.find(function(s) { return s.id === r.id; }); return [r.name, r.interface, label('profiles', r.profile), r.mtu, r.max_sessions, !connected ? 'Unknown · connection lost' : s ? s.state : 'Not applied', rowActions('servers', r)]; });
            } else if (active === 'secrets') {
                columns = ['Username', 'Server', 'Profile', 'Reserved address', 'Enabled', 'Actions'];
                rows = draft.secrets.map(function(r) { return [r.name, label('servers', r.server), r.profile ? label('profiles', r.profile) : 'Server default', r.remote_ip || r.assigned_ip || 'Assigned on apply', r.enabled ? 'Yes' : 'No', rowActions('secrets', r)]; });
            } else if (active === 'profiles') {
                columns = ['Name', 'Local address', 'Remote pool', 'DNS', 'Download', 'Upload', 'Actions'];
                rows = draft.profiles.map(function(r) { return [r.name, r.local_ip, label('pools', r.pool), [r.dns1, r.dns2].filter(Boolean).join(', ') || '—', r.download ? r.download + ' kbit/s' : 'Unlimited', r.upload ? r.upload + ' kbit/s' : 'Unlimited', rowActions('profiles', r)]; });
            } else if (active === 'pools') {
                columns = ['Name', 'First address', 'Last address', 'Actions'];
                rows = draft.pools.map(function(r) { return [r.name, r.start, r.end, rowActions('pools', r)]; });
            } else {
                columns = ['Username', 'Server', 'Profile', 'Interface', 'Address', 'Caller ID', 'Uptime', 'Downloaded', 'Uploaded', 'Actions'];
                rows = live.sessions.map(function(r) { return [r.name, label('servers', r.server), r.profile, r.interface, r.address, r.caller_id || '—', Math.floor(r.uptime / 60) + 'm ' + r.uptime % 60 + 's', r.tx_bytes == null ? '—' : (r.tx_bytes / 1048576).toFixed(2) + ' MiB', r.rx_bytes == null ? '—' : (r.rx_bytes / 1048576).toFixed(2) + ' MiB', button('Disconnect', function() {
                    ui.showModal('Disconnect ' + r.name, [E('p', {}, 'End this connection? The subscriber may reconnect unless you disable their secret and apply.'), E('div', {'class': 'pp-actions'}, [button('Cancel', ui.hideModal), button('Disconnect', async function() { ui.hideModal(); busy = true; draw(); try { checked(await disconnect(r.id)); live = checked(await status()); } catch(e) { notify(e); } finally { busy = false; draw(); } }, true)])]);
                })]; });
            }
            rows = rows.filter(function(row) { return row.some(function(v) { return (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(query); }); });
            var empty = !loaded ? (loadError ? 'Saved settings are unavailable. Use Retry to reconnect.' : 'Waiting for saved PPPoE settings…') : query ? 'No matching records.' : active === 'active' ? (connected ? 'No active PPPoE connections.' : 'Connection unavailable. Session status is unknown.') : 'No ' + sections.find(function(s) { return s[0] === active; })[1].toLowerCase() + ' configured.';
            table.replaceChildren(E('table', {'class': 'pp-table'}, [E('thead', {}, E('tr', {}, columns.map(function(c) { return E('th', {scope: 'col'}, c); }))), E('tbody', {}, rows.length ? rows.map(function(row) { return E('tr', {}, row.map(function(v) { return E('td', {}, typeof v === 'number' ? String(v) : v); })); }) : [E('tr', {}, E('td', {colspan: columns.length, 'class': 'pp-empty'}, empty))])]));
            table.querySelectorAll('button').forEach(function(b) { b.disabled = !editable() || (active === 'active' && !connected); });
        }
        function draw() {
            Array.from(tabs.children).forEach(function(tab, i) { var selected = sections[i][0] === active; tab.setAttribute('aria-selected', String(selected)); tab.setAttribute('tabindex', selected ? '0' : '-1'); });
            panel.setAttribute('aria-labelledby', 'pp-tab-' + active);
            var controls = [];
            if (active !== 'active') { var add = button('+ Add ' + ({servers: 'server', secrets: 'secret', profiles: 'profile', pools: 'pool'}[active]), function() { editor(active); }, true); add.disabled = !editable(); controls.push(add); }
            controls.push(search); toolbar.replaceChildren.apply(toolbar, controls);
            health.setAttribute('role', loadError ? 'alert' : 'status');
            health.textContent = !loaded ? (loadError || 'Getting saved configuration…') : !connected ? 'Connection lost · last received data' : !live.available ? 'PPPoE service packages are missing' : 'Live · refreshes every 5 seconds';
            note.textContent = active === 'pools' ? 'Pools reserve one stable address per account, including disabled accounts. Pools must not overlap each other or existing router networks.' : active === 'profiles' ? 'Profiles control subscriber addresses, DNS and upload/download limits. One connection per account. Rate limits apply when the subscriber connects.' : active === 'servers' ? 'Select an existing Ethernet, bridge or VLAN interface. Status reflects the last applied settings; pending edits take effect after Save & apply.' : active === 'secrets' ? 'Secrets authenticate subscribers using CHAP. Passwords are never returned by the router. Blank passwords on edit keep the existing value.' : 'Traffic totals are from the subscriber’s perspective. Last received values remain visible if the router connection fails.';
            var apply = button(busy ? 'Applying…' : 'Save & apply', confirmApply, true), discard = button('Discard edits', function() { draft = clone(baseline); draw(); });
            apply.disabled = !editable() || !changed() || !connected; discard.disabled = !changed() || busy || uncertain;
            footer.replaceChildren(E('span', {role: 'status'}, !loaded ? 'Configuration not received' : uncertain ? 'Save result unknown · reload to confirm' : readonly ? 'Read-only access' : changed() ? 'Unsaved changes' : 'Settings saved'), button(loadError ? 'Retry' : 'Reload', function() { if (!loaded) readConfig(); else if (!changed() || window.confirm('Discard unsaved changes and reload?')) window.location.reload(); }), discard, apply);
            drawTable();
        }
        function readConfig() {
            if (loadingConfig) return Promise.resolve();
            loadingConfig = true; loadError = ''; draw();
            return get().then(checked).then(function(value) {
                if (!value || !value.config || !value.status || !Array.isArray(value.interfaces)) throw new Error('Invalid PPPoE settings response.');
                baseline = clone(value.config); draft = clone(baseline); revision = value.revision;
                live = value.status; devices = value.interfaces; loaded = true; connected = true;
            }).catch(function(error) { loadError = error.message || 'Could not connect to the PPPoE service.'; connected = false; })
              .finally(function() { loadingConfig = false; draw(); });
        }
        draw();
        if (!loaded) readConfig();
        poll.add(function() { if (!loaded || busy || document.hidden || !root.isConnected) return Promise.resolve(); return status().then(checked).then(function(value) { live = value; connected = true; draw(); }).catch(function() { connected = false; draw(); }); }, 5);
        window.addEventListener('beforeunload', function(e) { if (changed()) { e.preventDefault(); e.returnValue = ''; } });
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
