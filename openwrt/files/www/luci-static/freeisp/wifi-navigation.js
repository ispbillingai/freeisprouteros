/* WiFi tabs supplement the unmodified native LuCI wireless editor. */
(function() {
    var base = '/cgi-bin/luci/admin/wifi';
    if (!location.pathname.startsWith(base)) return;
    var mount = document.getElementById('view') || document.getElementById('maincontent');
    if (!mount || document.querySelector('.fi-wifi-navigation')) return;
    var nav = document.createElement('nav');
    nav.className = 'fi-wifi-navigation'; nav.setAttribute('aria-label', 'WiFi sections');
    [['interfaces', 'WiFi Interfaces'], ['profiles', 'Security Profiles'], ['channels', 'Channels'], ['access', 'Access List'], ['registration', 'Registration'], ['connect', 'Connect List'], ['tools', 'Tools & Coverage']].forEach(function(item) {
        var a = document.createElement('a'); a.href = base + '/' + item[0]; a.textContent = item[1];
        if (location.pathname === a.pathname || (location.pathname === base && item[0] === 'interfaces')) a.setAttribute('aria-current', 'page');
        nav.appendChild(a);
    });
    var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/luci-static/resources/freeisp/wifi.css?v=1'; document.head.appendChild(css);
    mount.parentNode.insertBefore(nav, mount);
    if (/\/interfaces$/.test(location.pathname)) {
        var hint = document.createElement('p'); hint.className = 'fi-wifi-note';
        hint.textContent = 'WiFi · Manage radios and network interfaces below. Edit opens SSID, security, channel, access and roaming settings. No radio rows means no radio is configured; the VM has no WiFi hardware.';
        mount.parentNode.insertBefore(hint, mount);
    }
})();
