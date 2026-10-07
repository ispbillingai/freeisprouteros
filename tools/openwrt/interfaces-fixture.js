/* Local browser-test fixture only. Never shipped in the router overlay. */
window.startInterfacesFixture = async function(dataSource, viewSource, options) {
    options = options || {};
    const fixture = window.fixture = {
        calls: [], polls: [], notifications: [], pending: {}, saveFailure: false,
        sections: [
            {'.name': 'bridge', '.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth1']},
            {'.name': 'wan', '.type': 'interface', device: 'eth0', proto: 'dhcp'},
            {'.name': 'lan', '.type': 'interface', device: 'br-lan', proto: 'static', ipaddr: '10.77.0.1'},
            {'.name': 'management', '.type': 'interface', device: 'eth2', proto: 'static', ipaddr: '10.78.0.15'},
            {'.name': 'tag', '.type': 'device', name: 'vlan20', type: '8021q', ifname: 'eth0', vid: '20', ingress_qos_mapping: ['0:1']}
        ],
        metadata: {
            eth0: {type: 1, mtu: 1500}, eth1: {type: 1, mtu: 1500}, eth2: {type: 1, mtu: 1500},
            'br-lan': {type: 1, devtype: 'bridge', mtu: 1500}, vlan20: {type: 1, devtype: 'vlan', mtu: 1500}, lo: {type: 772, mtu: 65536}
        },
        states: [
            {interface: 'wan', up: true, device: 'eth0', 'ipv4-address': [{address: '10.0.2.15', mask: 24}]},
            {interface: 'lan', up: true, device: 'br-lan', 'ipv4-address': [{address: '10.77.0.1', mask: 24}]},
            {interface: 'management', up: true, device: 'eth2', 'ipv4-address': [{address: '10.78.0.15', mask: 24}]}
        ]
    };
    fixture.live = Object.fromEntries(Object.keys(fixture.metadata).map((name, i) => [name, {
        up: name !== 'vlan20', present: true, carrier: true, mtu: 1500, macaddr: '52:54:00:F1:00:0' + i, speed: '1000F',
        statistics: {tx_bytes: 100000 * i, rx_bytes: 200000 * i, tx_packets: 1500 * i, rx_packets: 2500 * i}
    }]));
    const copy = v => structuredClone(v);
    fixture.cache = copy(fixture.sections);
    const uci = {
        load: async () => { fixture.cache = copy(fixture.sections); }, unload: () => {}, sections: () => copy(fixture.cache),
        changes: async () => fixture.pending,
        add: (config, type) => { const sid = 'new' + fixture.cache.length; fixture.cache.push({'.name': sid, '.type': type}); fixture.calls.push(['add', config, type]); return sid; },
        set: (config, sid, key, value) => { fixture.calls.push(['set', config, sid, key, value]); const s = fixture.cache.find(s => s['.name'] === sid); if (value === '') delete s[key]; else s[key] = value; },
        remove: (config, sid) => { fixture.calls.push(['remove', config, sid]); fixture.cache = fixture.cache.filter(s => s['.name'] !== sid); },
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
        showModal: (title, content) => {
            ui.hideModal(); const modal = E('div', {id: 'fixture-modal', class: 'modal', role: 'dialog', 'aria-label': title}, [E('h3', {}, title), ...content]);
            document.body.append(modal);
        },
        addNotification: (_, node) => { fixture.notifications.push(node.textContent); document.querySelector('#notifications').append(node); },
        changes: {init: async () => fixture.calls.push(['init']), apply: checked => fixture.calls.push(['apply', checked])}
    };
    const rpc = {declare: config => async () => {
        if (fixture.rpcFailure) throw new Error('Offline');
        return copy(config.method === 'dump' ? fixture.states : config.method === 'getNetworkDevices' ? fixture.metadata : fixture.live);
    }};
    const L = {hasViewPermission: () => !options.readonly, url: (...parts) => '/cgi-bin/luci/' + parts.join('/'), resource: path => '/luci-static/resources/' + path};
    const data = new Function('baseclass', dataSource)({extend: v => v});
    const view = new Function('view', 'rpc', 'uci', 'ui', 'poll', 'data', 'E', 'L', viewSource)({extend: v => v}, rpc, uci, ui, {add: fn => fixture.polls.push(fn)}, data, E, L);
    document.querySelector('#maincontent').append(view.render(await view.load()));
};
