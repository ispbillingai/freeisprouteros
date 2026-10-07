/* Local browser-test fixture only. Never shipped in the router overlay. */
window.startFirewallFixture = async function(dataSource, viewSource, options) {
    options = options || {};
    const copy = value => structuredClone(value);
    const fixture = window.fixture = {
        calls: [], polls: [], notifications: [], pending: {}, saveFailure: false, applyFailure: false, runtimeFailure: false, serial: 0,
        sections: [
            {'.name': 'defaults', '.type': 'defaults', input: 'REJECT', forward: 'REJECT', output: 'ACCEPT'},
            {'.name': 'lan', '.type': 'zone', name: 'lan', network: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT'},
            {'.name': 'wan', '.type': 'zone', name: 'wan', network: ['wan'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1'},
            {'.name': 'management', '.type': 'zone', name: 'management', network: ['management'], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT'},
            {'.name': 'allow_dns', '.type': 'rule', name: 'Allow LAN DNS', src: 'lan', proto: ['tcp', 'udp'], dest_port: '53', target: 'ACCEPT', enabled: '1', log: '1', log_limit: '5/minute'},
            {'.name': 'block_telnet', '.type': 'rule', name: 'Block Telnet', src: 'wan', proto: 'tcp', dest_port: '23', target: 'DROP', enabled: '1'},
            {'.name': 'dscp', '.type': 'rule', name: 'Voice priority', src: 'lan', dest: 'wan', proto: 'udp', dest_port: '5060', target: 'DSCP', set_dscp: 'EF', enabled: '1'},
            {'.name': 'raw', '.type': 'rule', name: 'Untracked test traffic', src: 'lan', proto: 'udp', dest_ip: '198.51.100.1', dest_port: '9999', target: 'NOTRACK', enabled: '0'},
            {'.name': 'helper', '.type': 'rule', name: 'FTP helper', src: 'lan', proto: 'tcp', dest_port: '21', target: 'HELPER', set_helper: 'ftp', enabled: '0'},
            {'.name': 'web', '.type': 'redirect', name: 'Web server', src: 'wan', dest: 'lan', proto: 'tcp', src_dport: '8080', dest_ip: '10.77.0.10', dest_port: '80', target: 'DNAT', enabled: '0', family: 'ipv4', reflection: '1'},
            {'.name': 'trusted', '.type': 'ipset', name: 'trusted_clients', family: 'ipv4', match: ['src_net'], entry: ['10.77.0.0/24', '192.0.2.5']}
        ],
        live: {
            rules: [
                {chain: 'input_lan', comment: '!fw4: Allow LAN DNS', expression: 'udp dport 53 accept', bytes: 12400, packets: 120},
                {chain: 'input_wan', comment: '!fw4: Block Telnet', expression: 'tcp dport 23 drop', bytes: null, packets: null},
                {chain: 'input', comment: '!fw4: Accept established', expression: 'ct state established accept', bytes: 68000, packets: 510}
            ],
            connections: [{protocol: 'tcp', source: '198.51.100.4:45300', destination: '203.0.113.2:8080', replySource: '10.77.0.10:80', replyDestination: '198.51.100.4:45300', state: 'ESTABLISHED', expires: 7440, bytes: 5600}],
            helpers: [{name: 'ftp', description: 'FTP connection tracking', available: true, loaded: true}, {name: 'sip', description: 'SIP (not installed)', available: false, loaded: false}], errors: []
        }
    };
    fixture.cache = copy(fixture.sections);
    const uci = {
        load: async () => { fixture.cache = copy(fixture.sections); }, unload: () => {},
        sections: (config, type, callback) => { const rows = copy(fixture.cache.filter(s => !type || s['.type'] === type)); if (callback) rows.forEach(callback); return rows; },
        get: (config, sid, key) => { const s = fixture.cache.find(s => s['.name'] === sid); return key ? s?.[key] : copy(s); },
        changes: async () => copy(fixture.pending),
        add: (config, type, name) => { const sid = name || 'new_' + (++fixture.serial); fixture.cache.push({'.name': sid, '.type': type}); fixture.calls.push(['add', config, type, sid]); return sid; },
        set: (config, sid, key, value) => { fixture.calls.push(['set', config, sid, key, copy(value)]); const s = fixture.cache.find(s => s['.name'] === sid); if (!s) throw new Error('Unknown fixture section ' + sid); if (value == null || value === '') delete s[key]; else s[key] = copy(value); },
        unset: (config, sid, key) => { fixture.calls.push(['unset', config, sid, key]); const s = fixture.cache.find(s => s['.name'] === sid); if (s) delete s[key]; },
        remove: (config, sid) => { fixture.calls.push(['remove', config, sid]); fixture.cache = fixture.cache.filter(s => s['.name'] !== sid); },
        move: (config, sid, destination, after) => { fixture.calls.push(['move', config, sid, destination, after]); const source = fixture.cache.findIndex(s => s['.name'] === sid); const section = fixture.cache.splice(source, 1)[0]; const index = typeof destination === 'number' ? destination : fixture.cache.findIndex(s => s['.name'] === destination) + (after ? 1 : 0); fixture.cache.splice(index < 0 ? fixture.cache.length : index, 0, section); },
        reorder: (config, sid, index) => { fixture.calls.push(['reorder', config, sid, index]); const previous = fixture.cache.findIndex(s => s['.name'] === sid); const section = fixture.cache.splice(previous, 1)[0]; fixture.cache.splice(index, 0, section); },
        save: async () => { fixture.calls.push(['save']); if (fixture.saveFailure) throw new Error('Simulated save failure'); fixture.sections = copy(fixture.cache); }
    };
    function E(tag, attrs, children) {
        const e = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => { if (typeof v === 'function') e.addEventListener(k, v); else if (v != null) e.setAttribute(k, v); });
        (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(c => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
        return e;
    }
    const ui = {
        hideModal: () => document.querySelector('#fixture-modal')?.remove(),
        showModal: (title, content) => { ui.hideModal(); document.body.append(E('div', {id: 'fixture-modal', class: 'modal', role: 'dialog', 'aria-label': title}, [E('h3', {}, title), ...content])); },
        addNotification: (_, node) => { fixture.notifications.push(node.textContent); document.querySelector('#notifications').append(node); },
        changes: {init: async () => fixture.calls.push(['init']), apply: async checked => { fixture.calls.push(['apply', checked]); if (fixture.applyFailure) throw new Error('Simulated apply failure'); }}
    };
    const L = {hasViewPermission: () => !options.readonly, url: (...parts) => '/cgi-bin/luci/' + parts.join('/'), resource: path => '/luci-static/resources/' + path};
    const runtime = {load: async () => { if (fixture.runtimeFailure) throw new Error('Offline'); return copy(fixture.live); }};
    const data = new Function('baseclass', dataSource)({extend: value => value});
    const view = new Function('view', 'rpc', 'uci', 'ui', 'poll', 'data', 'runtime', 'E', 'L', viewSource)({extend: value => value}, {}, uci, ui, {add: fn => fixture.polls.push(fn)}, data, runtime, E, L);
    document.querySelector('#maincontent').append(view.render(await view.load()));
};
