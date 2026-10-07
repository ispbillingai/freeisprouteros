/* Browser fixture only; never shipped to the router. */
window.startQueuesFixture = async function(dataSource, viewSource, options = {}) {
    const fixture = window.fixture = {calls: [], polls: [], failures: options.failures || [], changes: options.changes || [], pending: {},
        devices: {eth0: {}, eth1: {}, eth2: {}}, scripts: [{name: 'piece_of_cake.qos'}, {name: 'simple.qos'}],
        runtime: [{dev: 'eth0', root: true, kind: 'cake', options: {bandwidth: 1250000}, bytes: 12345}],
        inventory: options.inventory || [{name: 'cake'}, {name: 'fq_codel'}],
        values: options.values || {
            wan: {'.type': 'queue', enabled: '1', interface: 'eth0', upload: '10000', download: '50000', qdisc: 'cake', script: 'piece_of_cake.qos'},
            backup: {'.type': 'queue', enabled: '0', interface: 'eth1', upload: '0', download: '10000', qdisc: 'custom', script: 'simple.qos'}
        }};
    function E(tag, attrs, children) {
        const el = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => typeof v === 'function' ? el.addEventListener(k, v) : el.setAttribute(k, v));
        (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(c => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
        return el;
    }
    const rpc = {declare: spec => async config => {
        fixture.calls.push([spec.object, spec.method, config]);
        if (spec.method === 'getNetworkDevices') return structuredClone(fixture.devices);
        if (config !== 'sqm' || !['get', 'changes'].includes(spec.method)) throw new Error('Unexpected RPC');
        if (fixture.failures.includes(spec.method)) throw new Error('Offline');
        const value = structuredClone(spec.method === 'get' ? fixture.values : fixture.changes);
        // Match LuCI's expect type handling, including config-scoped changes arrays.
        const expected = Object.values(spec.expect)[0];
        if (Array.isArray(value) !== Array.isArray(expected)) return structuredClone(expected);
        return value;
    }};
    const fs = {list: async path => {
        fixture.calls.push(['file', 'list', path]);
        if (path === '/usr/lib/sqm') return structuredClone(fixture.scripts);
        if (path !== '/var/run/sqm/available_qdiscs') throw new Error('Unexpected file access');
        if (fixture.failures.includes('list')) throw new Error('Unavailable');
        return structuredClone(fixture.inventory);
    }, exec: async (command, args) => {
        fixture.calls.push(['exec', command, args]);
        if (command === '/sbin/tc') {
            if (fixture.failures.includes('runtime')) return {code: 1};
            return {code: 0, stdout: JSON.stringify(fixture.runtime)};
        }
        if (command === '/etc/init.d/sqm' && args.join(' ') === 'enable') return {code: fixture.failures.includes('enable') ? 1 : 0};
        throw new Error('Unexpected command');
    }};
    const uci = {
        changes: async () => fixture.pending, unload: () => {},
        load: async () => { fixture.cache = structuredClone(fixture.values); },
        add: (config, type, id) => { fixture.calls.push(['add', config, id]); fixture.cache[id] = {'.type': type}; return id; },
        set: (config, id, key, value) => { fixture.calls.push(['set', config, id, key, value]); fixture.cache[id][key] = value; },
        remove: (config, id) => { fixture.calls.push(['remove', config, id]); delete fixture.cache[id]; },
        save: async () => { fixture.calls.push(['save']); if (fixture.failures.includes('save')) throw new Error('Save failed'); fixture.values = structuredClone(fixture.cache); }
    };
    const ui = {
        hideModal: () => document.querySelector('#fixture-modal')?.remove(),
        showModal: (title, content) => { ui.hideModal(); document.body.append(E('div', {id: 'fixture-modal', class: 'modal', role: 'dialog'}, [E('h3', {}, title), ...content])); },
        addNotification: (_, node) => document.querySelector('#notifications').append(node),
        changes: {init: async () => {}, apply: async rollback => { fixture.calls.push(['apply', rollback]); }}
    };
    const L = {hasViewPermission: () => !options.readonly, url: (...parts) => '/cgi-bin/luci/' + parts.join('/'), resource: path => '/luci-static/resources/' + path};
    const data = new Function('baseclass', dataSource)({extend: v => v});
    const view = new Function('view', 'rpc', 'fs', 'uci', 'ui', 'poll', 'data', 'E', 'L', viewSource)({extend: v => v}, rpc, fs, uci, ui, {add: fn => fixture.polls.push(fn)}, data, E, L);
    document.querySelector('#maincontent').append(view.render(await view.load()));
};
