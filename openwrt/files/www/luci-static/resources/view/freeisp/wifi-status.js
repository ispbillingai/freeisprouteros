'use strict';
'require view';
'require uci';
'require network';
'require rpc';
'require ui';
'require poll';
'require dom';

var frequencies = rpc.declare({ object: 'iwinfo', method: 'freqlist', params: ['device'], expect: { results: [] }, reject: true });
var associations = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: ['device'], expect: { results: [] }, reject: true });
function editor(label) { return E('a', { 'class': 'cbi-button cbi-button-action', href: L.url('admin', 'wifi', 'interfaces') }, label || 'Open WiFi editor'); }
function value(v, unit) { return v == null || v === '' ? 'Unavailable' : String(v) + (unit || ''); }
function table(headings, rows, empty) {
    return E('div', { 'class': 'table-responsive' }, E('table', { 'class': 'table fi-wifi-table' }, [
        E('tr', { 'class': 'tr table-titles' }, headings.map(function(h) { return E('th', { 'class': 'th' }, h); }))
    ].concat(rows.length ? rows.map(function(row) { return E('tr', { 'class': 'tr' }, row.map(function(cell) { return E('td', { 'class': 'td' }, cell); })); }) : [E('tr', { 'class': 'tr' }, E('td', { 'class': 'td', colspan: headings.length }, empty))])));
}
function note(text) { return E('p', { 'class': 'fi-wifi-note' }, text); }

return view.extend({
    load: function() {
        return uci.load('wireless').then(function() { return Promise.all([network.getWifiDevices(), network.getWifiNetworks()]); });
    },
    render: function(result) {
        var page = L.env.requestpath[L.env.requestpath.length - 1];
        var titles = { channels: 'Channels', access: 'Access List', registration: 'Registration', connect: 'Connect List', tools: 'WiFi Tools' };
        var radios = result[0], nets = result[1].filter(Boolean);
        var content = E('div', { 'class': 'fi-wifi-content' });
        var root = E('div', {}, [E('h2', {}, titles[page] || 'WiFi'), content]);
        if (!radios.length) content.appendChild(E('div', { 'class': 'cbi-section' }, [
            E('h3', {}, 'No WiFi radios configured'),
            note('This target has no configured WiFi radio. The current VM has no WiFi hardware. A physical router needs a supported radio, driver and WiFi service. Security profiles can be prepared before hardware is available.')
        ]));
        if (page === 'channels') {
            content.appendChild(note('Radio settings are shared by every SSID on that radio. In the WiFi editor, choose Edit on a network, then Device Configuration for country, band, channel, width, power and advanced radio settings.'));
            content.appendChild(editor('Edit radio settings'));
            content.appendChild(table(['Radio', 'State', 'Country', 'Band / width', 'Configured channel', 'Active channel', 'Transmit power'], radios.map(function(r) {
                var cfg = uci.get('wireless', r.getName()) || {}, net = nets.find(function(n) { return n.getWifiDeviceName() === r.getName() && n.isUp(); });
                return [r.getName(), r.isUp() ? 'Up' : 'Down', cfg.country || 'Driver default', [cfg.band, cfg.htmode].filter(Boolean).join(' / ') || 'Driver default', cfg.channel || 'Auto', net ? value(net.getChannel()) : 'Not active', cfg.txpower ? cfg.txpower + ' dBm (configured)' : 'Driver default'];
            }), 'No radios available.'));
            content.appendChild(note('Available frequencies below come from the driver for the current country. Restricted entries are not selectable recommendations. DFS channels may need a radar check; changing country, width or channel can interrupt all networks on a radio.'));
            radios.forEach(function(r) {
                var box = E('div', { 'class': 'cbi-section' }, [E('h3', {}, r.getName() + ' · Driver channel list')]);
                var output = E('div', {}, 'Loading channel information…'); box.appendChild(output); content.appendChild(box);
                frequencies(r.getName()).then(function(list) {
                    dom.content(output, table(['Channel', 'Frequency', 'Restriction'], list.map(function(f) { return [value(f.channel), value(f.mhz, ' MHz'), f.restricted ? 'Restricted by driver / country' : 'Driver permits']; }), 'The driver returned no channel information.'));
                }).catch(function() { dom.content(output, note('Channel information is unavailable. Check the radio driver and its current state.')); });
            });
        } else if (page === 'access') {
            content.appendChild(note('Per-network MAC allow/deny rules are configured under Edit → MAC-Filter. Client isolation is under Advanced Settings. MAC filtering is separate from password security and does not replace it.'));
            content.appendChild(editor('Edit access rules'));
            content.appendChild(table(['Interface / SSID', 'MAC policy', 'Addresses', 'Client isolation', 'Client limit'], uci.sections('wireless', 'wifi-iface').filter(function(n) { return n.mode === 'ap'; }).map(function(n) {
                var policy = { allow: 'Allow listed only', deny: 'Deny listed' }[n.macfilter] || 'Disabled';
                return [(n.ssid || n['.name']) + ' · ' + n['.name'], policy, [].concat(n.maclist || []).join(', ') || 'No entries', n.isolate === '1' ? 'Enabled' : 'Disabled', n.maxassoc || 'Driver default'];
            }), 'No access point interfaces configured.'));
            content.appendChild(note('Use Interfaces / Bridge / VLAN and Firewall to control guest networks and access to other networks.'));
        } else if (page === 'registration') {
            content.appendChild(note('Live associated clients and peers, refreshed every five seconds. Rates are negotiated link rates, not measured throughput. Disconnect controls are in WiFi Interfaces → Associated Stations.'));
            content.appendChild(editor('Manage connected clients'));
            var clients = E('div'), stamp = E('p', { role: 'status' });
            content.appendChild(stamp); content.appendChild(clients);
            var refresh = async function() {
                try {
                    await network.flushCache();
                    var current = (await network.getWifiNetworks()).filter(function(n) { return n && n.isUp(); });
                    var sources = current.flatMap(function(n) {
                        return [n].concat(typeof n.getVlans === 'function' ? n.getVlans() : []).map(function(device) {
                            return { network: n, device: device.getIfname() };
                        });
                    });
                    var results = await Promise.all(sources.map(async function(source) {
                        try { return { network: source.network, device: source.device, clients: await associations(source.device) }; }
                        catch (e) { return { network: source.network, device: source.device, error: true }; }
                    }));
                    var rows = [], failed = [];
                    results.forEach(function(entry) {
                        if (entry.error) { failed.push(entry.device); return; }
                        entry.clients.forEach(function(c) {
                            function rate(v) { return v && v.rate != null ? (v.rate / 1000).toFixed(1) + ' Mbit/s' : 'Unavailable'; }
                            rows.push([(entry.network.getSSID() || entry.network.getName()) + ' · ' + entry.device, c.mac || 'Unavailable', value(c.signal, ' dBm'), value(c.noise, ' dBm'), rate(c.rx), rate(c.tx), value(c.inactive, ' ms')]);
                        });
                    });
                    dom.content(clients, table(['Network', 'MAC address', 'Signal', 'Noise', 'RX rate', 'TX rate', 'Inactive'], rows, failed.length ? 'Client data could not be read.' : 'No associated clients reported.'));
                    stamp.textContent = 'Updated ' + new Date().toLocaleTimeString() + (failed.length ? ' · Unavailable: ' + failed.join(', ') : '');
                } catch (e) { stamp.textContent = 'Refresh failed. Any displayed clients are from the previous successful refresh.'; }
            };
            poll.add(refresh, 5);
            refresh();
        } else if (page === 'connect') {
            content.appendChild(note('Configured client connections. Use Scan on a radio in WiFi Interfaces to discover and join an upstream network. Edit the client interface for SSID, BSSID lock, security, network and WDS settings.'));
            content.appendChild(editor('Scan / join / edit connections'));
            content.appendChild(table(['Interface', 'Radio', 'SSID', 'BSSID lock', 'Security', 'Network', 'Configured state'], uci.sections('wireless', 'wifi-iface').filter(function(n) { return n.mode === 'sta'; }).map(function(n) {
                var r = uci.get('wireless', n.device) || {};
                return [n['.name'], n.device, n.ssid || 'Not set', n.bssid || 'Any matching access point', n.encryption || 'Open', [].concat(n.network || []).join(', ') || 'Unassigned', n.disabled === '1' || r.disabled === '1' ? 'Disabled' : 'Enabled'];
            }), 'No client connections configured.'));
            content.appendChild(note('Multiple saved client interfaces are not an ordered failover policy. For a repeater, configure a client uplink and a separate AP, then configure routing or compatible WDS bridging. Simultaneous AP/client operation depends on the radio and shares its channel.'));
        } else {
            content.appendChild(E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, 'Radio tools'),
                note('WiFi Interfaces provides Add, Edit, Remove, Enable / Disable, radio Restart, Scan / Join and client Disconnect. Scanning, restarting or changing security can interrupt wireless connections.'), editor(),
                E('h3', {}, 'Coverage and advanced settings'),
                table(['Feature', 'Where to configure it'], [
                    ['SSID, AP / client / mesh, network binding, hidden SSID, WDS', 'Edit → Interface Configuration → General Setup'],
                    ['WPA2 / WPA3, OWE, protected management frames, key renewal', 'Edit → Wireless Security, or Security Profiles for reusable settings'],
                    ['Country, band, channel, width, transmit power, legacy rates', 'Edit → Device Configuration'],
                    ['MAC allow / deny, isolation, WMM, client limits, multicast', 'Edit → MAC-Filter / Advanced Settings'],
                    ['802.11r fast transition, 802.11k / v roaming assistance', 'Edit → WLAN roaming; available settings depend on the WiFi service'],
                    ['WPS pushbutton setting', 'Edit → Wireless Security when supported; profile copies disable WPS'],
                    ['Mesh forwarding / RSSI, distance, beacon / DTIM and other tuning', 'Native editor advanced settings, where supported by the driver'],
                    ['Guest network, bridge / VLAN, DHCP, NAT and firewall', 'Interfaces / Bridge / VLAN, IP · DHCP and IP · Firewall']
                ], ''),
                E('h3', {}, 'Platform boundaries'),
                note('CAPsMAN / CAP, Nstreme Dual, proprietary 60 GHz station controls, MikroTik Interworking Profiles, Wireless Sniffer, Snooper and Alignment are not implemented here. The Scan results show nearby networks, not spectrum utilization. Passpoint / Hotspot 2.0 and automatic AP management are not provided by this workspace. Enterprise / RADIUS integration remains outside the FreeISP product scope.'),
                note('WiFi generations, 6 GHz, mesh, WDS, roaming and WPS depend on hardware, country rules, drivers and the installed WiFi service. Options shown by the native editor reflect those capabilities. No WiFi hardware has been tested on the current VM.'),
                E('a', { 'class': 'cbi-button', href: L.url('admin', 'status', 'syslog') }, 'System log'), ' ',
                E('a', { 'class': 'cbi-button', href: L.url('admin', 'network', 'diagnostics') }, 'Network diagnostics')
            ]));
        }
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
