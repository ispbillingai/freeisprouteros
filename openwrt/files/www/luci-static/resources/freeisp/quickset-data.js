'use strict';
'require baseclass';

function ip(value) {
    if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) throw new Error('Enter a valid IPv4 address.');
    var parts = value.split('.').map(Number);
    if (parts.some(function(n) { return n > 255; })) throw new Error('Enter a valid IPv4 address.');
    return parts.reduce(function(n, octet) { return n * 256 + octet; }, 0);
}
function address(n) { return [24,16,8,0].map(function(shift) { return (n >>> shift) & 255; }).join('.'); }
function subnet(value, mask) {
    var host = ip(value), bits = ip(mask), inverse = 4294967295 - bits;
    if (inverse < 3 || ((inverse + 1) & inverse) !== 0) throw new Error('Use a contiguous netmask from /1 to /30.');
    if (bits === 0) throw new Error('Use a contiguous netmask from /1 to /30.');
    var start = (host & bits) >>> 0, end = start + inverse;
    if (host === start || host === end) throw new Error('The router address cannot be the network or broadcast address.');
    return { host:host, start:start, end:end };
}
function pool(value, lan) {
    var parts = value.split('-').map(function(s) { return s.trim(); });
    if (parts.length !== 2) throw new Error('Enter the DHCP range as first address - last address.');
    var first = ip(parts[0]), last = ip(parts[1]);
    if (first > last || first <= lan.start || last >= lan.end) throw new Error('The DHCP range must be inside the local subnet.');
    if (first <= lan.host && last >= lan.host) throw new Error('The DHCP range must not include the router address.');
    return {start:first-lan.start, limit:last-first+1};
}
return baseclass.extend({ip:ip, address:address, subnet:subnet, pool:pool});
