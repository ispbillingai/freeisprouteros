'use strict';
'require baseclass';

// Templates are copied to selected interfaces, never linked or silently reapplied.
var modes = { psk2: 'WPA2 Personal (AES)', sae: 'WPA3 Personal', 'sae-mixed': 'WPA2 / WPA3 Personal', owe: 'Enhanced Open (OWE)' };
var owned = ['encryption', 'key', 'ieee80211w', 'wpa_group_rekey'];

function validate(profile) {
    if (!profile || !Object.prototype.hasOwnProperty.call(modes, profile.encryption)) throw new Error('Choose a supported personal security mode.');
    if (!profile.label || !profile.label.trim() || profile.label.length > 64) throw new Error('Profile name must contain 1–64 characters.');
    var key = profile.key || '', encryption = profile.encryption;
    if (encryption !== 'owe' && !(/^[\x20-\x7e]{8,63}$/.test(key) || (encryption === 'psk2' && /^[0-9a-fA-F]{64}$/.test(key))))
        throw new Error('Use an 8–63 character printable ASCII passphrase, or a 64-digit hexadecimal key for WPA2 only.');
    if (!['0', '1', '2'].includes(profile.ieee80211w)) throw new Error('Choose a management frame protection setting.');
    if (['sae', 'owe'].includes(encryption) && profile.ieee80211w !== '2') throw new Error('WPA3 and OWE require management frame protection.');
    if (encryption === 'sae-mixed' && profile.ieee80211w === '0') throw new Error('WPA2 / WPA3 requires optional or required management frame protection.');
    if (profile.wpa_group_rekey && !/^[1-9][0-9]{0,8}$/.test(profile.wpa_group_rekey)) throw new Error('Group key renewal must be a positive number of seconds (up to 999999999).');
    return true;
}

function plan(profile, targets, radios, hasFeature) {
    validate(profile);
    if (!targets.length) throw new Error('Select at least one WiFi interface.');
    var seen = new Set();
    return targets.map(function(target) {
        if (!target || target['.type'] !== 'wifi-iface' || seen.has(target['.name'])) throw new Error('The interface selection is no longer valid. Reload this page.');
        seen.add(target['.name']);
        var radio = radios.find(function(r) { return r['.name'] === target.device; });
        if (!radio || radio.type !== 'mac80211') throw new Error('This interface needs the native editor for its driver.');
        if (!['ap', 'sta', 'mesh'].includes(target.mode)) throw new Error('Profiles support AP, client and mesh interfaces. Use the native editor for other modes.');
        var service = target.mode === 'ap' ? 'hostapd' : 'wpasupplicant';
        if (!hasFeature(service)) throw new Error('The required WiFi service is not installed for ' + target['.name'] + '.');
        if (profile.encryption.startsWith('sae') && !hasFeature(service, 'sae')) throw new Error('WPA3 is unavailable in the installed WiFi service.');
        if (profile.encryption === 'owe' && !hasFeature(service, 'owe')) throw new Error('OWE is unavailable in the installed WiFi service.');
        if (target.mode === 'mesh' && (profile.encryption !== 'sae' || !hasFeature(service, 'mesh'))) throw new Error('Mesh requires WPA3 and a WiFi service with mesh support.');
        if ((radio.band === '6g' || Number(radio.frequency) >= 5925) && !['sae', 'owe'].includes(profile.encryption)) throw new Error('6 GHz requires WPA3 or OWE.');
        // Do not partially replace enterprise, WEP, PPSK or external key setups.
        if (target.encryption && !['none', 'psk2', 'psk2+ccmp', 'sae', 'sae-mixed', 'owe'].includes(target.encryption)) throw new Error('Use the native editor to change legacy or enterprise security first.');
        if (['auth_server', 'acct_server', 'eap_type', 'key1', 'key2', 'key3', 'key4', 'sae_password', 'wpa_psk_file', 'owe_transition_ifname', 'owe_transition_ssid', 'owe_transition_bssid'].some(function(k) { return !!target[k]; }) || target.ppsk === '1')
            throw new Error('This interface has advanced security settings. Change them in the native editor first.');
        if (target.ieee80211r === '1' && profile.encryption === 'owe') throw new Error('Disable fast transition in the native editor before using OWE.');
        var values = { encryption: profile.encryption, ieee80211w: profile.ieee80211w };
        if (profile.encryption !== 'owe') values.key = profile.key;
        if (profile.wpa_group_rekey) values.wpa_group_rekey = profile.wpa_group_rekey;
        // WPS cannot be retained when changing the authentication policy.
        return { section: target['.name'], values: values, unset: owned.filter(function(k) { return !(k in values); }).concat(['wps_pushbutton']) };
    });
}

return baseclass.extend({ modes: modes, validate: validate, plan: plan });
