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
            ['Interfaces', 'Ports, addresses and PPPoE client connections.', ['network','network']],
            ['Bridge / VLAN', 'Bridge ports, tagged and untagged VLANs and learned hosts.', ['network','freeisp_bridge']],
            ['Files', 'Persistent router file storage, upload and download.', ['system','freeisp_files']],
            ['Hotspot', 'Captive access, local accounts, profiles and active sessions.', ['network','freeisp_hotspot']],
            ['PPPoE', 'Servers, subscriber secrets, profiles, address pools and active connections.', ['network','freeisp_pppoe']],
            ['Firewall & NAT', 'Zones, forwarding rules, port forwards and traffic rules.', ['network','firewall']],
            ['DHCP', 'Address pools and static leases for your customer network.', ['network','dhcp']],
            ['DNS', 'DNS forwarding, local names and upstream resolvers.', ['network','dns']],
            ['Routing', 'IPv4 and IPv6 static routes and routing rules.', ['network','routes']],
            ['Queues', 'Upload and download shaping per interface. Configure PPPoE subscriber limits in their profiles.', ['network','freeisp_queues']],
            ['Bandwidth usage', 'Traffic accounting by local host through nlbwmon.', ['services','nlbw','display']],
            ['Tools', 'Router diagnostics, packet capture and supported maintenance tools.', ['network','freeisp_tools']],
            ['System & appearance', 'Identity, time and selectable interface themes.', ['system','system']],
            ['Backup & firmware', 'Configuration backup, restore and OpenWrt upgrade tools.', ['system','flash']],
            ['Logs', 'Live system and kernel events, with freeze and filtering.', ['status','freeisp_log']],
            ['Software', 'Install and remove packages from OpenWrt repositories.', ['system','package-manager']],
            ['Command Line', 'Router diagnostics, command history and identity settings.', ['system','freeisp_command_line']]
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
                E('p', {}, 'This target is a virtual router. It has no wireless radio or hardware switch. Configure subscriber services under PPPoE. FreeISP billing plans remain additional work. RADIUS is excluded. SQM is not a per-subscriber billing system.'),
                E('p', {}, 'Keep a settings backup. Hardware images must match their exact device; this image is for a virtual machine.')
            ])
        ]);
    },
    handleSaveApply:null, handleSave:null, handleReset:null
});
