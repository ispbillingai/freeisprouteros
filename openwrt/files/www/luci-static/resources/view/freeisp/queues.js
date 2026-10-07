'use strict';
'require view';
'require rpc';
'require fs';
'require uci';
'require ui';
'require poll';
'require freeisp.queues-data as data';

var getQueues = rpc.declare({object: 'uci', method: 'get', params: ['config'], expect: {values: {}}, reject: true});
var getChanges = rpc.declare({object: 'uci', method: 'changes', params: ['config'], expect: {changes: []}, reject: true});
var getDevices = rpc.declare({object: 'luci-rpc', method: 'getNetworkDevices', expect: {'': {}}, reject: true});
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function getRuntime() {
    return fs.exec('/sbin/tc', ['-s', '-j', 'qdisc', 'show']).then(function(result) {
        if (result.code !== 0) throw new Error('Queue status could not be read.');
        var parsed = JSON.parse(result.stdout);
        if (!Array.isArray(parsed)) throw new Error('Invalid queue status.');
        return parsed;
    });
}
function read(request) {
    return request.then(function(value) { return {ok: true, value: value}; }, function() { return {ok: false}; });
}

return view.extend({
    load: function() {
        return Promise.all([read(getQueues('sqm')), read(fs.list('/var/run/sqm/available_qdiscs')), read(getChanges('sqm')),
            read(fs.list('/usr/lib/sqm')), read(getDevices()), read(getRuntime())]);
    },
    render: function(result) {
        var self = this, snapshot = result, active = 0, busy = false;
        var baseline = clone(result[0].ok ? result[0].value : {}), draft = clone(baseline), locked = false, applied = false;
        var readonly = !L.hasViewPermission();
        function edits() { return data.operations(baseline, draft); }
        function error(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        function button(label, click, primary) { return E('button', {type: 'button', 'class': 'if-button' + (primary ? ' if-primary' : ''), click: click}, label); }
        function editor(id) {
            var source = id ? draft[id] : {enabled: '1', upload: '10000', download: '10000', qdisc: 'cake', script: 'piece_of_cake.qos'};
            var fields = {}, warning = E('p', {'class': 'if-error', role: 'alert'});
            var devices = Object.keys(snapshot[4].ok ? snapshot[4].value : {}).filter(function(name) { return name !== 'lo'; });
            if (source.interface && devices.indexOf(source.interface) < 0) devices.push(source.interface);
            var specs = [
                {key: 'name', label: 'Name', value: id || '', disabled: !!id},
                {key: 'interface', label: 'Interface', options: [''].concat(devices)},
                {key: 'enabled', label: 'Configuration', options: [['1', 'Enabled'], ['0', 'Disabled']]},
                {key: 'upload', label: 'Upload (kbit/s)'},
                {key: 'download', label: 'Download (kbit/s)'},
                {key: 'qdisc', label: 'Queue type', options: (snapshot[1].ok ? snapshot[1].value : []).map(function(q) { return q.name; })},
                {key: 'script', label: 'Setup script', options: (snapshot[3].ok ? snapshot[3].value : []).filter(function(s) { return /^[A-Za-z0-9_-]+\.qos$/.test(s.name); }).map(function(s) { return s.name; })}
            ];
            var rows = specs.map(function(spec) {
                var control = spec.options ? E('select', {id: 'queue-edit-' + spec.key}, spec.options.map(function(option) {
                    return E('option', {value: Array.isArray(option) ? option[0] : option}, Array.isArray(option) ? option[1] : option || 'Select a device');
                })) : E('input', {id: 'queue-edit-' + spec.key, type: 'text', inputmode: /^(upload|download)$/.test(spec.key) ? 'numeric' : 'text'});
                control.value = spec.value != null ? spec.value : source[spec.key] || ''; control.disabled = !!spec.disabled; fields[spec.key] = control;
                return E('div', {'class': 'if-field'}, [E('label', {'for': control.id}, spec.label), control]);
            });
            fields.qdisc.addEventListener('change', function() {
                var suggested = fields.qdisc.value === 'cake' ? 'piece_of_cake.qos' : fields.qdisc.value === 'fq_codel' ? 'simple.qos' : '';
                if (Array.from(fields.script.options).some(function(o) { return o.value === suggested; })) fields.script.value = suggested;
            });
            ui.showModal(id ? 'Edit queue · ' + id : 'Add interface queue', [
                E('div', {'class': 'if-editor'}, rows.concat([warning, E('p', {'class': 'if-muted'}, 'Rates are in kbit/s. Zero turns off shaping in that direction. Changes stay here until Review & apply.')])),
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), button('Save to review', function() {
                    try {
                        var values = {}; Object.keys(fields).forEach(function(key) { values[key] = fields[key].value.trim(); });
                        var valid = data.validate(values, draft, snapshot[4].ok ? snapshot[4].value : {}, snapshot[1].ok ? snapshot[1].value : [], snapshot[3].ok ? snapshot[3].value : [], id);
                        var name = id || values.name;
                        draft[name] = Object.assign({}, draft[name] || {'.type': 'queue'}, valid);
                        ui.hideModal(); drawTable();
                    } catch(e) { warning.textContent = e.message; }
                }, true)])
            ]);
            fields[id ? 'interface' : 'name'].focus();
        }
        function remove(id) {
            ui.showModal('Remove interface queue', [E('p', {}, 'Remove ' + id + '? Its bandwidth limits will be removed when you apply.'),
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), button('Remove queue', function() { delete draft[id]; ui.hideModal(); drawTable(); }, true)])]);
        }
        function review() {
            if (!edits().length || busy || locked || readonly) return;
            ui.showModal('Review queue changes', [
                E('ul', {}, edits().map(function(op) { return E('li', {}, op.kind + ' ' + op.id + (op.values ? ': ' + Object.keys(op.values).map(function(key) { return key + ' = ' + op.values[key]; }).join(', ') : '')); })),
                E('p', {}, 'SQM will reload these settings. Enabled queues also enable SQM at boot. OpenWrt will use its connection check and rollback protection.'),
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', ui.hideModal), button('Apply changes', function() { ui.hideModal(); self.applyEdits(); }, true)])
            ]);
        }
        self.applyEdits = async function() {
            if (busy || locked || readonly || !edits().length) return;
            busy = true; drawTable(); var staged = false;
            try {
                var pending = await uci.changes();
                if (Object.keys(pending).some(function(key) { return pending[key].length; })) throw new Error('OpenWrt already has pending changes. Apply or revert them first.');
                var current = await getQueues('sqm');
                if (JSON.stringify(current) !== JSON.stringify(baseline)) throw new Error('Queue configuration changed since this page loaded. Discard your edits and refresh before retrying.');
                uci.unload('sqm'); await uci.load('sqm');
                var ops = edits();
                staged = true; data.stage(uci, ops); await uci.save(); await ui.changes.init();
                if (Object.keys(draft).some(function(key) { return draft[key]['.type'] === 'queue' && draft[key].enabled === '1'; })) {
                    var enabled = await fs.exec('/etc/init.d/sqm', ['enable']);
                    if (enabled.code !== 0) throw new Error('Could not enable SQM at boot.');
                }
                document.addEventListener('uci-applied', function() { applied = true; window.location.reload(); }, {once: true});
                await ui.changes.apply(true); locked = true;
            } catch(e) {
                if (staged) { locked = true; error(new Error('Save/apply did not complete. Review OpenWrt pending changes and reload before retrying. ' + (e.message || e))); }
                else error(e);
            } finally { busy = false; drawTable(); }
        };
        var sections = [
            {title: 'Simple Queues', columns: ['Name', 'Target', 'Upload Max Limit', 'Download Max Limit', 'Packet Marks', 'Total Max Limit'],
                empty: 'Per-subscriber Simple Queues are not available in this build.',
                help: 'Individual IP and subscriber limits need a per-subscriber shaping service. Interface Queues provides the supported interface-wide SQM settings.'},
            {title: 'Interface Queues', columns: ['Name', 'Configuration', 'Interface', 'Upload Max Limit', 'Download Max Limit', 'Queue Type', 'Observed Upload Queue', 'Upload Bytes', 'Actions'],
                help: 'Limits use kbit/s; zero disables that direction. Configuration includes your pending edits. Observed upload queues and byte counters come from the kernel, independently of the saved settings. Download enforcement is not verified here. Counters restart when a queue is recreated.'},
            {title: 'Queue Tree', columns: ['Name', 'Parent', 'Packet Mark', 'Queue Type', 'Priority', 'Limit At', 'Max Limit'],
                empty: 'Hierarchical Queue Tree configuration is not available in this build.',
                help: 'Parent and child queues, packet-mark classification and shared bandwidth limits need additional backend support.'},
            {title: 'Queue Types', columns: ['Name', 'SQM Availability', 'Configured Queues'],
                help: 'Queue disciplines reported by SQM, plus any types referenced by configured queues. Availability does not confirm that a queue is running. Configure queue disciplines and setup scripts in SQM settings.'}
        ];
        var tabs = E('div', {'class': 'if-tabs', role: 'tablist', 'aria-label': 'Queue sections'});
        var table = E('div', {'class': 'if-table-wrap'});
        var help = E('p', {'class': 'if-help', id: 'queues-help'});
        var notice = E('p', {'class': 'if-help', role: 'status', 'aria-live': 'polite'});
        var footer = E('div', {'class': 'if-footer'});
        var health = E('span', {'class': 'if-muted', role: 'status'}, 'Configuration snapshot');
        var search = E('input', {type: 'search', placeholder: 'Find a queue…', 'aria-label': 'Filter queues', input: drawTable});
        var refresh = E('button', {type: 'button', 'class': 'if-button', click: function() {
            if (busy || locked || edits().length) return;
            busy = true; refresh.disabled = true; health.textContent = 'Refreshing…';
            return self.load().then(function(next) {
                snapshot = next;
                baseline = clone(next[0].ok ? next[0].value : {}); draft = clone(baseline);
                health.textContent = next[0].ok ? 'Updated ' + new Date().toLocaleTimeString() : 'Queue configuration unavailable';
                drawTable();
            }).finally(function() { busy = false; drawTable(); });
        }}, 'Refresh');
        var sqm = E('a', {'class': 'if-button if-primary', href: L.url('admin', 'network', 'sqm')}, 'Open SQM settings');
        var add = button('+ Add queue', function() { editor(); }, true);
        var toolbar = E('div', {'class': 'if-toolbar'}, [add, sqm, refresh, search]);
        var panel = E('section', {id: 'queues-panel', role: 'tabpanel', tabindex: '0', 'aria-describedby': 'queues-help'}, [toolbar, notice, table, help]);
        function drawTable() {
            var section = sections[active], rows = [], empty = section.empty, notes = [];
            var configured = snapshot[0].ok ? data.queues(draft) : [];
            if (active === 1) {
                rows = configured.map(function(q) {
                    var observed = data.runtime(q.device, snapshot[5].ok ? snapshot[5].value : null);
                    return [q.name, q.enabled ? 'Enabled' : 'Disabled', q.device, q.upload, q.download, q.qdisc, observed.label, observed.bytes,
                        E('div', {'class': 'if-row-actions'}, [button('Edit', function() { editor(q.name); }), button('Remove', function() { remove(q.name); })])];
                });
                empty = snapshot[0].ok ? 'No interface queues configured. Use Add queue to create one.' : 'Cannot read SQM configuration. Check your connection and access, then refresh.';
                if (!snapshot[5].ok) notes.push('Live queue status is unavailable. Runtime status and counters are unknown.');
            } else if (active === 3) {
                rows = data.types(configured, snapshot[1].ok ? snapshot[1].value : null).map(function(t) {
                    return [t.name, t.available === null ? 'Unknown' : t.available ? 'Available' : 'Not reported by SQM', snapshot[0].ok ? t.queues.join(', ') || 'None' : 'Unknown'];
                });
                empty = snapshot[1].ok ? 'No queue types reported by SQM. Open SQM settings to check the service.' : 'Queue type inventory unavailable. Open SQM settings to check the service, or refresh to retry.';
                if (!snapshot[1].ok) notes.push('Cannot read the SQM queue type inventory. Availability is unknown.');
            }
            if (active === 1 || active === 3) {
                if (!snapshot[0].ok) notes.push('SQM configuration could not be loaded.');
                if (!snapshot[2].ok) notes.push('Pending changes could not be checked. Displayed settings may include unapplied changes.');
                else if (snapshot[2].value.length) notes.push('Pending SQM changes: displayed settings include unapplied changes. Review them in SQM settings.');
            }
            var total = rows.length, query = search.value.trim().toLowerCase();
            rows = rows.filter(function(row) { return row.some(function(value) { return typeof value === 'string' && value.toLowerCase().indexOf(query) !== -1; }); });
            table.replaceChildren(E('table', {'class': 'if-table', 'aria-label': section.title}, [
                E('thead', {}, E('tr', {}, section.columns.map(function(column) { return E('th', {scope: 'col'}, column); }))),
                E('tbody', {}, rows.length ? rows.map(function(row) { return E('tr', {}, row.map(function(value) { return E('td', {}, value); })); }) :
                    E('tr', {}, E('td', {colspan: section.columns.length, 'class': 'if-empty'}, query && total ? 'No matching queues or types.' : empty)))
            ]));
            notice.textContent = notes.join(' '); notice.hidden = !notes.length;
            help.textContent = section.help;
            search.disabled = active === 0 || active === 2;
            var blocked = readonly || busy || locked || !snapshot[0].ok;
            add.hidden = active !== 1; add.disabled = blocked || !snapshot[1].ok || !snapshot[3].ok || !snapshot[4].ok;
            table.querySelectorAll('button').forEach(function(b) { b.disabled = blocked; });
            refresh.disabled = busy || locked || !!edits().length;
            var discard = button('Discard edits', function() { draft = clone(baseline); drawTable(); });
            var apply = button(busy ? 'Applying…' : 'Review & apply', review, true);
            discard.disabled = busy || locked || !edits().length;
            apply.disabled = blocked || !edits().length;
            footer.replaceChildren(E('span', {role: 'status'}, locked ? 'Reload required · review OpenWrt pending changes' : readonly ? 'Read-only access' : edits().length ? edits().length + ' queue changes to review' :
                active === 0 || active === 2 ? 'Backend support required' : rows.length + ' of ' + total + (active === 1 ? ' configured queues' : ' queue types')), discard, apply);
        }
        function select(index, focus) {
            active = index; search.value = '';
            Array.from(tabs.children).forEach(function(tab, i) {
                tab.setAttribute('aria-selected', String(i === active)); tab.setAttribute('tabindex', i === active ? '0' : '-1');
            });
            panel.setAttribute('aria-labelledby', 'queues-tab-' + active);
            drawTable();
            if (focus) tabs.children[active].focus();
        }
        sections.forEach(function(section, index) {
            tabs.appendChild(E('button', {type: 'button', 'class': 'if-button', id: 'queues-tab-' + index, role: 'tab', 'aria-controls': 'queues-panel',
                click: function() { select(index, false); },
                keydown: function(event) {
                    var next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1;
                    if (next !== -1) { event.preventDefault(); select(next, true); }
                }
            }, section.title));
        });
        select(0, false);
        poll.add(function() {
            return read(getRuntime()).then(function(observed) {
                snapshot[5] = observed; drawTable();
            });
        }, 5);
        window.addEventListener('beforeunload', function(event) {
            if (edits().length && !busy && !locked && !applied) { event.preventDefault(); event.returnValue = ''; }
        });
        if (!snapshot[0].ok) health.textContent = 'Queue configuration unavailable';
        return E('div', {'class': 'if-window'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/queues.css') + '?v=1'}),
            E('div', {'class': 'if-heading'}, [E('div', {}, [E('h2', {}, 'Queue List'), E('p', {}, 'Bandwidth limits and interface shaping.')]), health]),
            E('div', {'class': 'if-card'}, [tabs, panel, footer])
        ]);
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
