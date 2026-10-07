'use strict';
'require view';
'require rpc';
'require ui';

var board = rpc.declare({object:'system', method:'board', expect:{'':{}}});
var info = rpc.declare({object:'system', method:'info', expect:{'':{}}});
return view.extend({
    load: function() { return Promise.all([board(), info()]); },
    render: function(data) {
        var links = [
            ['WiFi', 'Interfaces, security profiles, channels, access lists and connected clients.', ['wifi','interfaces']],
            ['Interfaces & bridges', 'Ports, addresses, bridges, VLANs and PPPoE client connections.', ['network','network']],
            ['Firewall & NAT', 'Zones, forwarding rules, port forwards and traffic rules.', ['network','firewall']],
            ['DHCP', 'Address pools and static leases for your customer network.', ['network','dhcp']],
            ['DNS', 'DNS forwarding, local names and upstream resolvers.', ['network','dns']],
            ['Routing', 'IPv4 and IPv6 static routes and routing rules.', ['network','routes']],
            ['Queues / SQM', 'Upload and download shaping per interface. Individual subscriber queues come later.', ['network','sqm']],
            ['Bandwidth usage', 'Traffic accounting by local host through nlbwmon.', ['services','nlbw','display']],
            ['Diagnostics', 'Ping, traceroute and DNS lookup from the router.', ['network','diagnostics']],
            ['System & appearance', 'Identity, time and selectable interface themes.', ['system','system']],
            ['Backup & firmware', 'Configuration backup, restore and OpenWrt upgrade tools.', ['system','flash']],
            ['Logs', 'Live system and kernel events, with freeze and filtering.', ['status','freeisp_log']],
            ['Software', 'Install and remove packages from OpenWrt repositories.', ['system','package-manager']],
            ['Commands', 'Authenticated maintenance commands; start with memory and uptime.', ['system','commands']]
        ];
        return E('div', {}, [
            E('div', {'class':'freeisp-intro'}, [E('h2', {}, 'FreeISP router workspace'),
                E('p', {}, 'Built on OpenWrt. Make it yours.'),
                E('small', {}, (data[0].release || {}).description + ' · ' + data[0].hostname + ' · Uptime ' + Math.floor(data[1].uptime / 60) + ' minutes')]),
            E('div', {'class':'freeisp-grid'}, links.map(function(item) {
                return E('a', {'class':'freeisp-tile', 'href':L.url.apply(L, ['admin'].concat(item[2]))}, [E('strong', {}, item[0]), E('p', {}, item[1])]);
            })),
            E('div', {'class':'freeisp-note'}, [
                E('strong', {}, 'Your platform, with a tested foundation.'),
                E('p', {}, 'Choose FreeISP, FreeISP Night, Bootstrap or OpenWrt 2020 under System → System → Language and Style. Router settings and add-on packages remain available through LuCI.'),
                E('p', {}, 'This target is a virtual router. It has no wireless radio or hardware switch. PPPoE server, hotspot and FreeISP subscriber plans are not configured. RADIUS is excluded. SQM is not a per-subscriber billing system.'),
                E('p', {}, 'Keep a settings backup. Hardware images must match their exact device; this image is for a virtual machine.')
            ])
        ]);
    },
    handleSaveApply:null, handleSave:null, handleReset:null
});
