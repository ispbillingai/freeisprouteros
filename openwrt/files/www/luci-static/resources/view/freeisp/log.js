'use strict';
'require view';
'require rpc';
'require poll';
'require freeisp.log-data as data';

// OpenWrt 25.12 logd: bounded, non-streaming snapshots of its actual memory buffer.
var readLog = rpc.declare({object: 'log', method: 'read', params: ['lines', 'stream', 'oneshot'], reject: true});

return view.extend({
    render: function() {
        var rows = [], loaded = false, frozen = false, busy = false, generation = 0, failure = '', updated = '';
        var status = E('span', {role: 'status', 'aria-live': 'polite'});
        var notice = E('p', {'class': 'fi-log-error', role: 'alert', hidden: ''});
        var body = E('tbody');
        var count = E('span');
        var wrap = E('div', {'class': 'fi-log-scroll', tabindex: '0', 'aria-label': 'Router log entries'}, [
            E('table', {'class': 'fi-log-table'}, [E('thead', {}, E('tr', {}, ['#', 'Time (UTC)', 'Buffer', 'Topics', 'Message'].map(function(s) { return E('th', {scope: 'col'}, s); }))), body])
        ]);
        function button(label, action) { return E('button', {type: 'button', 'class': 'cbi-button', click: action}, label); }
        var search = E('input', {type: 'search', placeholder: 'Search logs…', 'aria-label': 'Search logs', input: draw});
        var severity = E('select', {'aria-label': 'Severity', change: draw}, [E('option', {value: ''}, 'All severities')].concat(data.severities.map(function(s) { return E('option', {value: s}, s); })));
        var facility = E('select', {'aria-label': 'Facility', change: draw}, [E('option', {value: ''}, 'All facilities')]);
        var follow = E('input', {type: 'checkbox', checked: '', change: function() { if (follow.checked) wrap.scrollTop = wrap.scrollHeight; }});
        // Browser preferences are scoped to this router origin; no router settings are written.
        try {
            var preferences = JSON.parse(localStorage.getItem('freeisp-log-preferences') || '{}');
            if (preferences && data.severities.indexOf(preferences.severity) !== -1) severity.value = preferences.severity;
            if (preferences && typeof preferences.follow === 'boolean') follow.checked = preferences.follow;
        } catch(e) {}
        function savePreferences() {
            try { localStorage.setItem('freeisp-log-preferences', JSON.stringify({severity: severity.value, follow: follow.checked})); } catch(e) {}
        }
        severity.addEventListener('change', savePreferences);
        follow.addEventListener('change', savePreferences);
        var freeze = button('Freeze', function() {
            frozen = !frozen; generation++;
            freeze.textContent = frozen ? 'Resume' : 'Freeze';
            freeze.setAttribute('aria-pressed', String(frozen)); draw();
            if (!frozen) refresh();
        });
        freeze.setAttribute('aria-pressed', 'false');
        var retry = button('Refresh', refresh);
        var download = button('Download visible logs', function() {
            var url = URL.createObjectURL(new Blob([data.text(visible())], {type: 'text/plain;charset=utf-8'}));
            var link = E('a', {href: url, download: 'freeisp-logs.txt'});
            document.body.appendChild(link); link.click(); link.remove();
            window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        });
        function visible() { return data.filter(rows, search.value, severity.value, facility.value); }
        function draw() {
            var shown = visible(), scroll = wrap.scrollTop;
            body.replaceChildren();
            shown.forEach(function(row) {
                // Explicit text nodes keep router messages safe with any LuCI DOM helper.
                body.appendChild(E('tr', {'data-severity': row.severity}, [row.id, row.time, 'memory', row.topics, row.message].map(function(value) { return E('td', {}, document.createTextNode(value)); })));
            });
            if (!shown.length) body.appendChild(E('tr', {}, E('td', {colspan: '5', 'class': 'fi-log-empty'}, !loaded ? (failure ? 'Log data is unavailable.' : 'Loading router logs…') : rows.length ? 'No matching log entries.' : 'The router log buffer is empty.')));
            count.textContent = shown.length + ' shown / ' + rows.length + ' loaded · Latest 1,000 entries';
            status.textContent = (frozen ? 'Frozen' : failure ? 'Connection error' : busy ? 'Refreshing…' : 'Live · every 5 seconds') + (updated ? ' · Last updated ' + updated : '');
            notice.hidden = !failure;
            notice.textContent = failure ? 'Unable to read router logs: ' + failure + (loaded ? ' Showing the last successful snapshot.' : '') : '';
            retry.disabled = busy || frozen; download.disabled = !shown.length;
            wrap.scrollTop = follow.checked ? wrap.scrollHeight : scroll;
        }
        async function refresh() {
            if (frozen || busy) return;
            var requestGeneration = generation;
            busy = true; draw();
            try {
                var next = data.parse(await readLog(1000, false, true));
                if (generation !== requestGeneration) return;
                rows = next; loaded = true; failure = ''; updated = new Date().toLocaleTimeString();
                var selected = facility.value;
                var names = Array.from(new Set(rows.map(function(row) { return row.facility; }).concat(selected ? [selected] : []))).sort();
                facility.replaceChildren(E('option', {value: ''}, 'All facilities'));
                names.forEach(function(name) { facility.appendChild(E('option', {value: name}, name)); });
                facility.value = selected;
            } catch(e) {
                if (generation === requestGeneration) failure = e.message || String(e);
            } finally {
                busy = false; draw();
                if (!frozen && generation !== requestGeneration) refresh();
            }
        }
        poll.add(refresh, 5);
        refresh();
        return E('div', {'class': 'fi-log'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/log.css')}),
            E('div', {'class': 'fi-log-heading'}, [E('h2', {}, 'Log'), status]),
            E('div', {'class': 'fi-log-panel'}, [
                E('div', {'class': 'fi-log-toolbar'}, [freeze, retry, search, severity, facility, E('label', {}, [follow, ' Follow latest']), download]),
                notice, wrap,
                E('div', {'class': 'fi-log-footer'}, [count, E('span', {}, 'Memory buffer · older entries rotate out; reboot clears logs')])
            ])
        ]);
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
