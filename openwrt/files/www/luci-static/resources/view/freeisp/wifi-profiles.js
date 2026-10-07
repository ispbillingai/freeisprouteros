'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require freeisp.wifi-data as data';

return view.extend({
    load: function() { return Promise.all([uci.load('freeisp_wifi'), uci.load('wireless')]); },
    render: function() {
        var self = this;
        var m = new form.Map('freeisp_wifi', 'Security Profiles', 'Save reusable personal security settings, then copy a profile to selected WiFi interfaces. Editing or deleting a profile does not change interfaces that previously used it. Passwords are included in router backups.');
        var s = m.section(form.GridSection, 'profile', 'Saved profiles');
        s.anonymous = true; s.addremove = true; s.nodescriptions = true;
        var o = s.option(form.Value, 'label', 'Profile name');
        o.rmempty = false; o.datatype = 'maxlength(64)';
        o.validate = function(section, value) { return value && value.trim() ? true : 'Enter a profile name.'; };
        o = s.option(form.ListValue, 'encryption', 'Security');
        Object.keys(data.modes).forEach(function(k) { o.value(k, data.modes[k]); });
        o.default = 'sae'; o.rmempty = false;
        o = s.option(form.Value, 'key', 'Passphrase');
        o.password = true; o.modalonly = true; o.rmempty = false;
        ['psk2', 'sae', 'sae-mixed'].forEach(function(k) { o.depends('encryption', k); });
        o.validate = function(section, value) {
            var mode = m.lookupOption('encryption', section)[0].formvalue(section);
            return /^[\x20-\x7e]{8,63}$/.test(value || '') || (mode === 'psk2' && /^[a-fA-F0-9]{64}$/.test(value || '')) ? true : 'Use 8–63 printable ASCII characters; WPA2 also accepts a 64-digit hexadecimal key.';
        };
        o = s.option(form.ListValue, 'ieee80211w', 'Management frame protection');
        o.value('0', 'Disabled'); o.value('1', 'Optional'); o.value('2', 'Required'); o.default = '2'; o.rmempty = false;
        o.validate = function(section, value) {
            var mode = m.lookupOption('encryption', section)[0].formvalue(section);
            if (['sae', 'owe'].includes(mode) && value !== '2') return 'WPA3 and OWE require management frame protection.';
            return mode === 'sae-mixed' && value === '0' ? 'Mixed mode requires optional or required protection.' : true;
        };
        o = s.option(form.Value, 'wpa_group_rekey', 'Group key renewal (seconds)', 'Leave empty to use the WiFi service default.');
        o.datatype = 'range(1,999999999)'; o.modalonly = true;
        o = s.option(form.Button, '_use', 'Use profile');
        o.inputtitle = 'Choose interfaces'; o.inputstyle = 'action';
        o.onclick = function(ev, section) { return self.chooseInterfaces(m, section); };
        return m.render();
    },
    chooseInterfaces: async function(map, section) {
        try {
            if (!L.hasViewPermission()) throw new Error('You have read-only access.');
            await map.save();
            var profile = uci.get('freeisp_wifi', section);
            data.validate(profile);
            var interfaces = uci.sections('wireless', 'wifi-iface');
            var choices = interfaces.map(function(net) {
                return { section: net['.name'], input: E('input', { type: 'checkbox' }), label: (net.ssid || net.mesh_id || net['.name']) + ' · ' + net['.name'] + ' · ' + net.device };
            });
            var status = E('p', { role: 'status' });
            var button = E('button', { 'class': 'btn cbi-button-positive', disabled: !choices.length, click: async function() {
                button.disabled = true;
                try {
                    if (!L.hasViewPermission()) throw new Error('You have read-only access.');
                    var pending = await uci.changes();
                    if (pending.wireless && pending.wireless.length) throw new Error('Apply or revert pending WiFi changes before copying a profile.');
                    var targets = choices.filter(function(c) { return c.input.checked; }).map(function(c) { return uci.get('wireless', c.section); });
                    var changes = data.plan(profile, targets, uci.sections('wireless', 'wifi-device'), L.hasSystemFeature.bind(L));
                    // Validate every target before modifying any configuration.
                    changes.forEach(function(change) {
                        change.unset.forEach(function(k) { uci.unset('wireless', change.section, k); });
                        Object.keys(change.values).forEach(function(k) { uci.set('wireless', change.section, k, change.values[k]); });
                    });
                    await uci.save();
                    await ui.changes.init();
                    ui.hideModal();
                    ui.addNotification(null, E('p', {}, 'Profile copied to ' + changes.length + ' interface(s). Review pending changes and use Save & Apply to activate them.'), 'info');
                } catch (error) { status.textContent = error.message; }
                finally { button.disabled = !choices.length; }
            } }, 'Stage security changes');
            ui.showModal('Use ' + profile.label, [
                E('p', {}, data.modes[profile.encryption] + ' · Management frame protection: ' + ({ '0': 'disabled', '1': 'optional', '2': 'required' })[profile.ieee80211w]),
                E('p', {}, 'This replaces encryption, password, management frame protection and key renewal on selected interfaces, and disables WPS. SSIDs, channels and network assignments stay as configured. Applying changes can disconnect WiFi clients.'),
                E('div', { 'class': 'fi-wifi-choices' }, choices.length ? choices.map(function(c) { return E('label', {}, [c.input, ' ' + c.label]); }) : [E('p', {}, 'No WiFi interfaces are configured. Add one in WiFi Interfaces on a supported radio first.')]),
                status,
                E('div', { 'class': 'right' }, [E('button', { 'class': 'btn', click: ui.hideModal }, 'Cancel'), ' ', button])
            ]);
        } catch (error) { ui.addNotification(null, E('p', {}, error.message), 'error'); }
    }
});
