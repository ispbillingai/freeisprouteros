'use strict';
'require view';
'require form';

return view.extend({
    render: function() {
        var map = new form.Map('freeisp_api', 'API', 'Disabled by default. Enable only on a trusted management network or protected tunnel: API credentials and traffic are unencrypted. Connect a RouterOS API client using the router root account. Unsupported commands return an error.');
        var section = map.section(form.NamedSection, 'main', 'service', 'API connection');
        section.addremove = false;
        var option = section.option(form.Flag, 'enabled', 'Enabled');
        option.default = '0'; option.rmempty = false;
        option = section.option(form.Value, 'port', 'Port');
        option.datatype = 'port'; option.default = '8728'; option.rmempty = false;
        option = section.option(form.Value, 'listen_address', 'Listen address', '0.0.0.0 listens on all IPv4 interfaces. Firewall rules determine which clients can connect.');
        option.datatype = 'ip4addr("nomask")'; option.default = '0.0.0.0'; option.rmempty = false;
        return map.render();
    }
});
