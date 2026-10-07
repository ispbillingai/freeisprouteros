/* FreeISP navigation; underlying settings are the original LuCI views. */
document.addEventListener('DOMContentLoaded', function() {
    if (document.querySelector('input[name="luci_password"]')) return;
    var sidebar = document.createElement('nav');
    sidebar.className = 'freeisp-sidebar';
    sidebar.setAttribute('aria-label', 'Router navigation');
    var entries = [
        ['Workspace', null], ['Quick Set', 'freeisp'], ['Overview', 'status/overview'],
        ['Network', null], ['Interfaces', 'network/network'], ['Bridge / VLAN', 'network/network'],
        ['PPP clients', 'network/network'], ['IP · DHCP', 'network/dhcp'], ['IP · DNS', 'network/dns'],
        ['IP · Firewall', 'network/firewall'], ['Routing', 'network/routes'], ['Queues / SQM', 'network/sqm'],
        ['Bandwidth', 'services/nlbw/display'], ['Administration', null],
        ['System', 'system/system'], ['Files / Backups', 'system/flash'], ['Log', 'status/syslog'],
        ['Tools', 'network/diagnostics'], ['Commands', 'system/commands'], ['Software', 'system/package-manager'], ['Logout', 'logout']
    ];
    entries.forEach(function(item) {
        var element = document.createElement(item[1] ? 'a' : 'span');
        element.textContent = item[0];
        if (item[1]) {
            element.href = '/cgi-bin/luci/admin/' + item[1];
            if (location.pathname === element.pathname) element.classList.add('active');
        } else element.className = 'group';
        sidebar.appendChild(element);
    });
    var more = document.createElement('button');
    more.textContent = 'All OpenWrt menus';
    more.onclick = function() { document.body.classList.toggle('freeisp-allmenus'); };
    sidebar.appendChild(more);
    document.body.appendChild(sidebar);
    document.body.classList.add('freeisp-desktop');
});
