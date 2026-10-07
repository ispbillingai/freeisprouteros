/* FreeISP navigation; underlying settings are the original LuCI views. */
(function() {
    document.querySelectorAll('link[rel="stylesheet"]').forEach(function(link) {
        if (/\/freeisp(?:-night)?\/cascade\.css/.test(link.href)) {
            var url = new URL(link.href); url.searchParams.set('freeisp','day-night-2'); link.href = url.href;
        }
    });
    var theme;
    try { theme = localStorage.getItem('freeisp-theme'); } catch(e) {}
    if (theme === 'day' || theme === 'night') document.documentElement.dataset.freeispTheme = theme;
})();
document.addEventListener('DOMContentLoaded', function() {
    if (document.querySelector('input[name="luci_password"]')) return;
    var sidebar = document.createElement('nav');
    sidebar.className = 'freeisp-sidebar';
    sidebar.setAttribute('aria-label', 'Router navigation');
    var logo = document.createElement('div');
    logo.className = 'fi-logo';
    logo.innerHTML = '<span class="freeisp-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>FreeISP Desk</span>';
    sidebar.appendChild(logo);
    var paths = [
        'M5 3v7h14v11M2 3h6M16 21h6',
        'M4 18V9m8 9V3m8 15v-6',
        'M3 4h18v12H3zM8 21h8m-4-5v5',
        'M3 5h6v6H3zM15 13h6v6h-6zM9 8h9v5',
        'M8 5H3v5h5zM21 14h-5v5h5zM8 8h4v9h4',
        'M3 6h18M3 12h18M3 18h18M7 3v6m10 0v6m-8 0v6',
        'M4 4h16v16H4zM8 8h8m-8 4h8m-8 4h5'
    ];
    var activeAssigned = false;
    var entries = [
        ['Workspace', null], ['Quick Set', 'freeisp'], ['Overview', 'status/overview'],
        ['Network', null], ['Interfaces', 'network/network'], ['Bridge / VLAN', 'network/network'],
        ['PPP clients', 'network/network'], ['IP · DHCP', 'network/dhcp'], ['IP · DNS', 'network/dns'],
        ['IP · Firewall', 'network/firewall'], ['Routing', 'network/routes'], ['Queues', 'network/freeisp_queues'],
        ['Bandwidth', 'services/nlbw/display'], ['Administration', null],
        ['System', 'system/system'], ['Files', 'system/freeisp_files'], ['Log', 'status/freeisp_log'],
        ['Tools', 'network/diagnostics'], ['Commands', 'system/commands'], ['Software', 'system/package-manager'], ['Logout', 'logout']
    ];
    entries.forEach(function(item) {
        var element = document.createElement(item[1] ? 'a' : 'span');
        element.textContent = item[0];
        if (item[1]) {
            var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
            svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('class','fi-nav-icon'); svg.setAttribute('aria-hidden','true');
            var path = document.createElementNS('http://www.w3.org/2000/svg','path');
            path.setAttribute('d',paths[sidebar.querySelectorAll('a').length % paths.length]);
            path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor'); path.setAttribute('stroke-width','1.6'); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round');
            svg.appendChild(path); element.prepend(svg);
            element.href = '/cgi-bin/luci/admin/' + item[1];
            if (!activeAssigned && location.pathname === element.pathname) { element.classList.add('active'); element.setAttribute('aria-current','page'); activeAssigned = true; }
        } else element.className = 'group';
        sidebar.appendChild(element);
    });
    var more = document.createElement('button');
    more.textContent = 'All OpenWrt menus';
    more.onclick = function() { document.body.classList.toggle('freeisp-allmenus'); };
    sidebar.appendChild(more);
    document.body.appendChild(sidebar);
    document.body.classList.add('freeisp-desktop');
    var header = document.querySelector('header');
    if (header) {
        var brand = header.querySelector('.brand');
        if (brand) brand.textContent = 'Workspace / ' + ((sidebar.querySelector('a.active') || {}).textContent || 'FreeISP');
        var toggle = document.createElement('div'); toggle.className='fi-theme-switch'; toggle.setAttribute('aria-label','Appearance');
        function setTheme(theme, persist) {
            document.documentElement.dataset.freeispTheme=theme;
            if (persist) { try { localStorage.setItem('freeisp-theme',theme); } catch(e) {} }
            toggle.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.theme===theme));});
        }
        ['day','night'].forEach(function(theme){var b=document.createElement('button'); b.type='button';b.dataset.theme=theme;b.textContent=theme==='day'?'☀ Day':'☾ Night';b.setAttribute('aria-label',theme==='day'?'Use Day theme':'Use Night theme');b.onclick=function(){setTheme(theme,true);};toggle.appendChild(b);});
        header.appendChild(toggle);
        setTheme(document.documentElement.dataset.freeispTheme || (document.querySelector('link[href*="freeisp-night"]')?'night':'day'),false);
        window.addEventListener('storage',function(e){if(e.key==='freeisp-theme' && /^(day|night)$/.test(e.newValue)) setTheme(e.newValue,false);});
    }
});
