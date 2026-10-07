'use strict';
'require view';
'require form';

return view.extend({
    render: function() {
        var map = new form.Map('freeisp_ftp', 'FTP', 'Disabled by default. Enable only on a trusted management network or protected tunnel: FTP credentials and transfers are unencrypted. Sign in with the router root account to access the confined /files folder.');
        var section = map.section(form.NamedSection, 'main', 'service', 'FTP connection');
        section.addremove = false;
        var option = section.option(form.Flag, 'enabled', 'Enabled');
        option.default = '0'; option.rmempty = false;
        var port = section.option(form.Value, 'port', 'Port');
        port.datatype = 'port'; port.default = '21'; port.rmempty = false;
        option = section.option(form.Value, 'listen_address', 'Listen address', '0.0.0.0 listens on all IPv4 interfaces. Firewall rules determine which clients can connect.');
        option.datatype = 'ip4addr("nomask")'; option.default = '0.0.0.0'; option.rmempty = false;
        var low = section.option(form.Value, 'passive_min_port', 'First passive port');
        low.datatype = 'range(1024,65535)'; low.default = '50000'; low.rmempty = false;
        var high = section.option(form.Value, 'passive_max_port', 'Last passive port');
        high.datatype = 'range(1024,65535)'; high.default = '50009'; high.rmempty = false;
        high.validate = function(id, value) {
            var start = Number(low.formvalue(id)), end = Number(value), control = Number(port.formvalue(id));
            if (!/^\d+$/.test(value) || end < 1024 || end > 65535) return 'Enter a port from 1024 to 65535.';
            if (end < start) return 'The last passive port must be at least the first passive port.';
            if (control >= start && control <= end) return 'The FTP control port must be outside the passive range.';
            return true;
        };
        option = section.option(form.Value, 'passive_address', 'Passive address', 'Optional IPv4 address to advertise when connecting through port forwarding.');
        option.datatype = 'ip4addr("nomask")'; option.rmempty = true;
        return map.render();
    }
});
