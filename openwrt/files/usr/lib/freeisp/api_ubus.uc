// Credentials and session tokens arrive on stdin, never in process arguments.
// Direct ubus calls do not enforce ACLs, so explicitly check them for each call.
'use strict';
let fs = require('fs');
let ubus = require('ubus');
let bus = ubus.connect(null, 5);
let failure_code = 'service-failed';

function fail(message) { die(message); }
function raw(object, method, params) {
    let reply = bus.call(object, method, params);
    let status = ubus.error(true);
    if (status != null && status != 0) fail('Router service request failed');
    // Successful mutation methods may have no response body.
    return reply == null ? {} : reply;
}
function permitted(sid, scope, object, method) {
    let result = raw('session', 'access', {
        ubus_rpc_session: sid, scope, object, function: method
    });
    if (result.access != true) fail('Permission denied');
}
function call(sid, object, method, params) {
    permitted(sid, 'ubus', object, method);
    params.ubus_rpc_session = sid;
    return raw(object, method, params);
}

try {
    if (!bus) fail('Router services unavailable');
    let source = fs.stdin.read(16385);
    if (!source || length(source) > 16384) fail('Invalid request');
    let request = json(source);
    if (type(request) != 'object') fail('Invalid request');
    let result;
    if (request.action == 'login') {
        if (request.username != 'root' || type(request.password) != 'string' ||
            !length(request.password) || length(request.password) > 1024)
            fail('Invalid user name or password');
        let login = raw('session', 'login', {
            username: 'root', password: request.password, timeout: 300
        });
        if (!login.ubus_rpc_session || login.data?.username != 'root')
            fail('Invalid user name or password');
        result = { session: login.ubus_rpc_session };
    }
    else {
        let sid = request.session;
        if (type(sid) != 'string' || !match(sid, /^[a-f0-9]{32}$/) ||
            sid == '00000000000000000000000000000000') fail('Authentication required');
        let identity = raw('session', 'get', { ubus_rpc_session: sid, keys: ['username'] });
        if (identity.values?.username != 'root') fail('Authentication required');
        if (request.action == 'destroy') result = raw('session', 'destroy', { ubus_rpc_session: sid });
        else if (request.action == 'call') {
            let object = request.object, method = request.method, params = request.params || {};
            let allowed = (object == 'system' && (method == 'board' || method == 'info')) ||
                (object == 'network.device' && method == 'status') ||
                (object == 'network.interface' && method == 'dump') ||
                (object == 'service' && method == 'list');
            if (object == 'uci' && method == 'get') {
                allowed = index(['system', 'network', 'dhcp', 'dropbear', 'uhttpd', 'freeisp_api', 'freeisp_ftp'], params.config) >= 0;
                if (allowed) permitted(sid, 'uci', params.config, 'read');
            }
            if (object == 'file' && method == 'list' && params.path == '/srv/freeisp/files') {
                allowed = true;
                permitted(sid, 'file', params.path, 'list');
            }
            if (!allowed) fail('Unsupported router service request');
            result = call(sid, object, method, params);
        }
        else if (request.action == 'identity-set') {
            let name = request.name;
            if (type(name) != 'string' || length(name) > 63 ||
                !match(name, /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/))
                fail('Name must be a hostname of 1 to 63 letters, digits or hyphens');
            permitted(sid, 'uci', 'system', 'write');
            // Preflight all rights before staging a persistent change.
            for (let method in ['get', 'set', 'commit', 'revert']) permitted(sid, 'ubus', 'uci', method);
            permitted(sid, 'ubus', 'file', 'exec');
            permitted(sid, 'file', '/etc/init.d/system', 'exec');
            let values = call(sid, 'uci', 'get', { config: 'system' }).values;
            let section;
            for (let key, value in values) {
                if (value['.type'] == 'system') { section = key; break; }
            }
            if (!section) fail('System configuration unavailable');
            call(sid, 'uci', 'set', { config: 'system', section, values: { hostname: name } });
            try { call(sid, 'uci', 'commit', { config: 'system' }); }
            catch (e) {
                call(sid, 'uci', 'revert', { config: 'system' });
                fail('Unable to save hostname');
            }
            failure_code = 'hostname-saved-reload-failed';
            let reload = call(sid, 'file', 'exec', { command: '/etc/init.d/system', params: ['reload'] });
            if (reload.code != 0) {
                failure_code = 'hostname-saved-reload-failed';
                fail('Hostname saved but system reload failed');
            }
            result = {};
        }
        else fail('Unsupported request');
    }
    printf('%J\n', { ok: true, result });
}
catch (e) { printf('%J\n', { ok: false, code: failure_code }); }
