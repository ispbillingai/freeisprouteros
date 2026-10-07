'use strict';
'require baseclass';

function list(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function unique(values) { return Array.from(new Set(values)); }
function enabled(value) { return !/^(0|off|false|no)$/i.test(String(value == null ? '1' : value)); }
function sections(result, type) {
    return result && result.ok ? Object.keys(result.values).map(function(k) { return Object.assign({'.name': k}, result.values[k]); }).filter(function(s) { return s['.type'] === type; }) : [];
}
function endpoint(value, protocol, instance) {
    var text = String(value), match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(text);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return {port: 'Unknown', address: text, protocol: protocol, instance: instance};
    return {port: match[2], address: match[1], protocol: protocol, instance: instance};
}
function web(result) {
    var listeners = [], active = false;
    sections(result, 'uhttpd').forEach(function(s) {
        ['http', 'https'].forEach(function(protocol) {
            list(s['listen_' + protocol]).forEach(function(value) {
                var listener = endpoint(value, protocol.toUpperCase(), s['.name'] || 'Web server');
                listener.disabled = !enabled(s.enabled); listeners.push(listener);
                if (!listener.disabled) active = true;
            });
        });
    });
    return {state: !result || !result.ok ? 'unknown' : !listeners.length ? 'unconfigured' : active ? 'configured' : 'disabled', listeners: listeners};
}
function service(result, protocol, defaultPort) {
    var section = sections(result, 'service').filter(function(s) { return s['.name'] === 'main'; })[0];
    return {state: !result || !result.ok ? 'unknown' : !section ? 'unconfigured' : enabled(section.enabled) ? 'configured' : 'disabled',
        listeners: section ? [{port: String(section.port || defaultPort), address: section.listen_address || '0.0.0.0', protocol: protocol, instance: 'main', disabled: !enabled(section.enabled)}] : []};
}
function runtime(connection, result, name) {
    if (!result || !result.ok || connection.state === 'unknown') return Object.assign({}, connection, {state: 'unknown'});
    var process = result.values[name] || {}, instances = process.instances || {};
    if (Object.keys(instances).some(function(k) { return instances[k].running === true; })) return Object.assign({}, connection, {state: 'running'});
    return Object.assign({}, connection, {state: connection.state === 'configured' ? 'stopped' : connection.state});
}
function ssh(result) {
    var instances = sections(result, 'dropbear');
    var enabled = instances.filter(function(s) { return !/^(0|off|false|no)$/i.test(String(s.enable == null ? '1' : s.enable)); });
    return {
        state: !result || !result.ok ? 'unknown' : !instances.length ? 'unconfigured' : !enabled.length ? 'disabled' : 'configured',
        listeners: instances.map(function(s) {
            var enabled = !/^(0|off|false|no)$/i.test(String(s.enable == null ? '1' : s.enable));
            return {port: String(s.Port || '22'), address: s.DirectInterface || s.Interface || 'All interfaces', protocol: 'SSH', instance: s['.name'] || 'SSH server', disabled: !enabled};
        })
    };
}
function row(id, name, connection, description, settings) {
    var listeners = connection.listeners || [];
    return {id: id, name: name, state: connection.state, listeners: listeners,
        ports: unique(listeners.map(function(l) { return l.port; })).join(', ') || '—',
        addresses: unique(listeners.map(function(l) { return l.address; })).join(', ') || '—',
        description: description, settings: settings};
}

return baseclass.extend({
    rows: function(snapshot) {
        var status = snapshot.runtime || {}, shared = runtime(web(snapshot.uhttpd), status.uhttpd, 'uhttpd');
        return [
            row('api', 'API', runtime(service(snapshot.freeisp_api, 'API', '8728'), status['freeisp-api'], 'freeisp-api'), 'Authenticated RouterOS-compatible commands.', ['network', 'freeisp_api_settings']),
            row('ftp', 'FTP', runtime(service(snapshot.freeisp_ftp, 'FTP', '21'), status['freeisp-ftp'], 'freeisp-ftp'), 'Upload and download router files.', ['network', 'freeisp_ftp_settings']),
            row('ssh', 'SSH', runtime(ssh(snapshot.dropbear), status.dropbear, 'dropbear'), 'Secure command-line access to the router.', ['system', 'admin', 'dropbear']),
            row('desk', 'FreeISP Desk', shared, 'Uses the same HTTP / HTTPS connection as WWW.', ['system', 'admin', 'uhttpd']),
            row('www', 'WWW', shared, 'Router management in your web browser.', ['system', 'admin', 'uhttpd'])
        ];
    },
    label: function(state) {
        return {running: 'Running', stopped: 'Stopped', configured: 'Configured', disabled: 'Disabled', unconfigured: 'Not configured', unknown: 'Unknown'}[state] || 'Unknown';
    }
});
