/* Isolated browser fixture. It never connects to a router. */
window.startBridgeFixture = async function(dataSource, viewSource, options) {
    options = options || {};
    const copy = v => JSON.parse(JSON.stringify(v));
    const initial = [
        {'.name': 'bridge', '.type': 'device', name: 'br-lan', type: 'bridge', ports: ['eth1', 'eth2'], stp: '1', vlan_filtering: '1'},
        {'.name': 'v10', '.type': 'bridge-vlan', device: 'br-lan', vlan: '10', ports: ['eth1:u*', 'eth2:t'], local: '1'},
        {'.name': 'wan', '.type': 'interface', device: 'eth0', proto: 'dhcp'},
        {'.name': 'lan', '.type': 'interface', device: 'br-lan.10', proto: 'static', ipaddr: '10.77.0.1', netmask: '255.255.255.0'}
    ];
    let saved = copy(options.sections || initial), config = copy(saved), id = 0;
    const stats = {rx_bytes: 10000, tx_bytes: 20000, rx_packets: 100, tx_packets: 200};
    const fixture = window.fixture = {options, calls: [], polls: [], live: {
        'br-lan': {type: 'bridge', up: true, present: true, mtu: 1500, macaddr: '02:00:00:00:00:01', 'bridge-members': ['eth1', 'eth2'], 'bridge-attributes': {stp: true, vlan_filtering: true}, statistics: copy(stats)},
        eth0: {up: true, carrier: true}, eth1: {up: true, carrier: true, statistics: copy(stats)}, eth2: {up: true, carrier: false, statistics: copy(stats)}, eth3: {up: true, carrier: true}
    }, saved: () => copy(saved), reloaded: false};
    const E = window.E = function(tag, attrs, children) {
        const n = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => { if (typeof v === 'function') n.addEventListener(k, v); else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v)); });
        function add(v) { if (Array.isArray(v)) v.forEach(add); else if (v != null) n.append(v instanceof Node ? v : document.createTextNode(String(v))); }
        add(children); return n;
    };
    const L = {hasViewPermission: () => !options.readonly, url: (...s) => '/cgi-bin/luci/' + s.join('/'), resource: s => '/luci-static/resources/' + s};
    const uci = {
        load: async () => { config = copy(saved); if (options.changed && fixture.calls.includes('unload')) config[0].mtu = '1400'; },
        unload: () => fixture.calls.push('unload'), sections: () => config,
        changes: async () => options.pending ? {network: [['set', 'other', 'mtu', '1400']]} : {},
        add: (c, type) => { const name = 'new' + (++id); config.push({'.name': name, '.type': type}); fixture.calls.push('add'); return name; },
        set: (c, s, k, v) => { fixture.calls.push('set'); config.find(x => x['.name'] === s)[k] = copy(v); },
        unset: (c, s, k) => { fixture.calls.push('unset'); delete config.find(x => x['.name'] === s)[k]; },
        remove: (c, s) => { fixture.calls.push('remove'); config = config.filter(x => x['.name'] !== s); },
        save: async () => { fixture.calls.push('save'); if (options.saveFailure) throw new Error('Connection lost during save'); saved = copy(config); }
    };
    const ui = {
        showModal: (title, content) => { ui.hideModal(); const n = E('div', {'class': 'modal', role: 'dialog', 'aria-label': title}, [E('h3', {}, title), content]); document.body.append(n); },
        hideModal: () => document.querySelector('.modal')?.remove(),
        addNotification: (title, node) => document.querySelector('#notifications').append(node),
        changes: {init: async () => fixture.calls.push('changes.init'), apply: async rollback => { fixture.calls.push('apply:' + rollback); if (options.applyFailure) throw new Error('Connection lost during apply'); }}
    };
    const rpc = {declare: () => async () => { if (options.statusFailure) throw new Error('Router unreachable'); return copy(fixture.live); }};
    const fs = {exec_direct: async () => {
        if (options.telemetryFailure) throw new Error('Permission denied');
        const wrap = value => ({code: 0, output: JSON.stringify(value)});
        const hosts = Array.from({length: options.hostCount || 3}, (_, i) => ({mac: '02:11:22:33:' + Math.floor(i / 256).toString(16).padStart(2, '0') + ':' + (i % 256).toString(16).padStart(2, '0'), ifname: 'eth1', master: 'br-lan', vlan: 10, state: i === 0 ? 'permanent' : i === 1 ? 'static' : '', used: i * 2, updated: i}));
        return {link: wrap([{ifname: 'eth1', master: 'br-lan', state: 'forwarding', cost: 100, learning: true, isolated: false}]), fdb: wrap(hosts), vlan: wrap([{ifname: 'eth1', vlans: [{vlan: 10, flags: ['PVID', 'Egress Untagged']}]}])};
    }};
    const data = new Function('baseclass', dataSource)({extend: v => v});
    const view = new Function('view', 'rpc', 'uci', 'ui', 'fs', 'poll', 'data', 'L', 'E', viewSource)({extend: v => v}, rpc, uci, ui, fs, {add: f => fixture.polls.push(f)}, data, L, E);
    fixture.reload = async () => { document.querySelector('#maincontent').replaceChildren(view.render(await view.load())); };
    await fixture.reload();
};
