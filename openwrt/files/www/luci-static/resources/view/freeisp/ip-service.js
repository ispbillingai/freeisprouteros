'use strict';
'require view';
'require rpc';
'require ui';
'require freeisp.ip-service-data as data';

var getConfig = rpc.declare({object: 'uci', method: 'get', params: ['config'], expect: {values: {}}, reject: true});
var getService = rpc.declare({object: 'service', method: 'list', params: ['name'], expect: {'': {}}, reject: true});
function readConfig(name) {
    return getConfig(name).then(function(values) { return {ok: true, values: values}; }).catch(function() { return {ok: false, values: {}}; });
}
function readSnapshot() {
    var configs = ['dropbear', 'uhttpd', 'freeisp_api', 'freeisp_ftp'], services = ['dropbear', 'uhttpd', 'freeisp-api', 'freeisp-ftp'];
    return Promise.all(configs.map(readConfig).concat(services.map(function(name) {
        return getService(name).then(function(values) { return {ok: true, values: values}; }).catch(function() { return {ok: false, values: {}}; });
    }))).then(function(values) {
        var snapshot = {runtime: {}};
        configs.forEach(function(name, i) { snapshot[name] = values[i]; });
        services.forEach(function(name, i) { snapshot.runtime[name] = values[i + configs.length]; });
        return snapshot;
    });
}

return view.extend({
    load: readSnapshot,
    render: function(snapshot) {
        var rows = data.rows(snapshot), refreshing = false;
        function button(label, action) { return E('button', {type: 'button', 'class': 'ips-button', click: action}, label); }
        function link(label, path) { return E('a', {'class': 'ips-button', href: L.url.apply(L, ['admin'].concat(path))}, label); }
        function badge(row) { return E('span', {'class': 'ips-state ips-' + row.state}, data.label(row.state)); }
        function details(row) {
            var content = [E('p', {}, row.description)];
            if (row.state === 'unknown') content.push(E('p', {'class': 'ips-warning'}, 'The router settings could not be read. Refresh the list to try again.'));
            if (row.listeners.length) content.push(E('div', {'class': 'ips-table-wrap'}, E('table', {'class': 'ips-table', 'aria-label': row.name + ' connections'}, [
                E('thead', {}, E('tr', {}, ['Protocol', 'Port', 'Listen on', 'Instance'].map(function(text) { return E('th', {scope: 'col'}, text); }))),
                E('tbody', {}, row.listeners.map(function(listener) { return E('tr', {}, [
                    E('td', {}, listener.protocol), E('td', {}, listener.port), E('td', {}, listener.address),
                    E('td', {}, listener.instance + (listener.disabled ? ' · Disabled' : ''))
                ]); }))
            ])));
            if (row.id === 'api') content.push(E('p', {'class': 'ips-muted'}, 'Sign in with the router root account. This API implements the documented FreeISP command subset; unsupported RouterOS commands return an error.'));
            if (row.id === 'ftp') content.push(E('p', {'class': 'ips-muted'}, 'Sign in with the router root account. Transfers are confined to the FreeISP file folder. FTP also uses the passive ports shown in FTP settings.'));
            if (row.id === 'desk' || row.id === 'www') content.push(E('p', {'class': 'ips-muted'}, 'FreeISP Desk and WWW share these settings. FreeISP Desk does not have a separate service port.'));
            if (row.listeners.length) content.push(E('p', {'class': 'ips-muted'}, 'Ports and listen addresses come from saved configuration. Running reports the server process; firewall rules determine which clients can connect.'));
            var actions = [button('Close', ui.hideModal)];
            if (row.settings) actions.push(link(row.id === 'api' ? 'API settings' : row.id === 'ftp' ? 'FTP settings' : row.id === 'ssh' ? 'SSH settings' : 'Web settings', row.settings));
            content.push(E('div', {'class': 'ips-modal-actions'}, actions));
            ui.showModal(row.name, content);
        }
        var table = E('div', {'class': 'ips-table-wrap'});
        var health = E('span', {'class': 'ips-muted', role: 'status'});
        var count = E('span', {}, '5 services');
        var search = E('input', {type: 'search', placeholder: 'Find a service…', 'aria-label': 'Find a service', input: draw});
        var refresh = button('Refresh', function() {
            if (refreshing) return;
            refreshing = true; refresh.disabled = true; health.textContent = 'Reading router settings…';
            return readSnapshot().then(function(next) { snapshot = next; rows = data.rows(next); draw(); })
                .finally(function() { refreshing = false; refresh.disabled = false; });
        });
        function draw() {
            var query = search.value.trim().toLowerCase();
            var visible = rows.filter(function(row) { return [row.name, row.ports, row.addresses, data.label(row.state), row.description].join(' ').toLowerCase().indexOf(query) !== -1; });
            table.replaceChildren(E('table', {'class': 'ips-table', 'aria-label': 'IP Service list'}, [
                E('thead', {}, E('tr', {}, ['Name', 'Status', 'Port', 'Listen on', 'Description', ''].map(function(text) { return E('th', {scope: 'col'}, text || 'Actions'); }))),
                E('tbody', {}, visible.length ? visible.map(function(row) {
                    var detailButton = button('Details', function() { details(row); });
                    detailButton.setAttribute('aria-label', row.name + ' details');
                    return E('tr', {}, [E('td', {'class': 'ips-name'}, row.name), E('td', {}, badge(row)), E('td', {'class': 'ips-port'}, row.ports),
                        E('td', {'class': 'ips-address'}, row.addresses), E('td', {'class': 'ips-description'}, row.description), E('td', {}, detailButton)]);
                }) : E('tr', {}, E('td', {colspan: 6, 'class': 'ips-empty'}, 'No matching services.')))
            ]));
            count.textContent = query ? visible.length + ' of 5 services' : '5 services';
            health.textContent = rows.some(function(row) { return row.state === 'unknown'; }) ? 'Some service data could not be read · Refresh to retry' : 'Router services loaded';
        }
        draw();
        return E('div', {'class': 'ips-window'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/ip-service.css') + '?v=1'}),
            E('div', {'class': 'ips-heading'}, [E('div', {}, [E('h2', {}, 'IP Service'), E('p', {}, 'API, file transfer and router management access.')]), health]),
            E('div', {'class': 'ips-card'}, [
                E('div', {'class': 'ips-toolbar'}, [E('strong', {}, 'IP Service List'), refresh, search]), table,
                E('p', {'class': 'ips-help'}, 'FreeISP Desk and WWW share the router’s web connection. Status reports the server process; ports show configured settings. Firewall rules determine which clients can connect.'),
                E('div', {'class': 'ips-footer'}, [count, link('Access rules', ['network', 'firewall'])])
            ])
        ]);
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
