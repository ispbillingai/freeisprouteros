'use strict';
'require baseclass';

function field(key, label, type, extra) { return Object.assign({ key:key, label:label, type:type || 'text' }, extra || {}); }
var common = [field('disabled','Disabled','checkbox'),field('comment','Comment','text',{max:1024})];
var server = field('server','Server','reference',{collection:'servers',all:true});
var schemas = [
    {key:'servers',label:'Servers',singular:'Server',columns:['name','interface','address_pool','profile','addresses_per_mac'],fields:[field('name','Name','text',{required:true,max:128}),field('interface','Interface','interface',{required:true}),field('address_pool','Client subnet','cidr',{required:true,placeholder:'10.42.0.0/24'}),field('profile','Server profile','reference',{required:true,collection:'server_profiles'}),field('addresses_per_mac','Addresses per MAC','number',{min:1,max:64,value:2})].concat(common)},
    {key:'server_profiles',label:'Server Profiles',singular:'Server profile',columns:['name','hotspot_address','dns_name','http_port','cookie_login'],fields:[field('name','Name','text',{required:true,max:128}),field('hotspot_address','Hotspot address','ip',{required:true,placeholder:'10.42.0.1'}),field('dns_name','DNS name','hostname',{placeholder:'login.example.com'}),field('http_port','Login port','number',{min:1024,max:65535,value:6480}),field('cookie_login','Remember sign-in','checkbox',{value:true}),field('cookie_lifetime','Cookie lifetime (seconds)','number',{min:60,max:31536000,value:86400})].concat(common)},
    {key:'users',label:'Users',singular:'User',columns:['name','profile','server','mac_address','limit_uptime','uptime','bytes_in','bytes_out'],fields:[field('name','Username','text',{required:true,max:128}),field('password','Password','password',{max:1024}),field('profile','User profile','reference',{required:true,collection:'user_profiles'}),server,field('mac_address','MAC address','mac'),field('limit_uptime','Total time limit (seconds, 0 = unlimited)','number',{min:0,value:0}),field('limit_bytes_in','Download quota (bytes, 0 = unlimited)','number',{min:0,value:0}),field('limit_bytes_out','Upload quota (bytes, 0 = unlimited)','number',{min:0,value:0})].concat(common)},
    {key:'user_profiles',label:'User Profiles',singular:'User profile',columns:['name','shared_users','session_timeout','idle_timeout','rate_limit_up','rate_limit_down'],fields:[field('name','Name','text',{required:true,max:128}),field('shared_users','Concurrent sessions','number',{min:1,max:1000,value:1}),field('session_timeout','Session timeout (seconds, 0 = unlimited)','number',{min:0,max:1099511627776,value:0}),field('idle_timeout','Idle timeout (seconds, 0 = unlimited)','number',{min:0,max:1099511627776,value:300}),field('rate_limit_up','Upload speed (bytes/second, 0 = unlimited)','number',{min:0,max:1099511627776,value:0}),field('rate_limit_down','Download speed (bytes/second, 0 = unlimited)','number',{min:0,max:1099511627776,value:0})].concat(common)},
    {key:'active',label:'Active',singular:'Session',live:true,columns:['user','server','address','mac_address','uptime','bytes_in','bytes_out']},
    {key:'hosts',label:'Hosts',singular:'Host',live:true,columns:['address','mac_address','server','interface','state','authorized']},
    {key:'ip_bindings',label:'IP Bindings',singular:'IP binding',columns:['address','mac_address','server','type'],fields:[field('address','IP address or subnet','cidr'),field('mac_address','MAC address','mac'),server,field('type','Access','select',{options:[['regular','Requires sign-in'],['bypassed','Bypass sign-in'],['blocked','Blocked']],value:'regular'})].concat(common)},
    {key:'service_ports',label:'Service Ports',singular:'Service port',columns:['name','protocol','ports'],fields:[field('name','Name','text',{required:true,max:128}),field('protocol','Protocol','select',{options:['tcp','udp'],value:'tcp'}),field('ports','Ports','ports',{required:true,placeholder:'80,443,8000-8080'})].concat(common)},
    {key:'walled_garden',label:'Walled Garden',singular:'Walled garden rule',columns:['host','port','server','action'],fields:[server,field('host','Host name','hostname',{required:true,placeholder:'example.com'}),field('port','Port (0 = all)','number',{min:0,max:65535,value:0}),field('action','Action','select',{options:['allow','deny'],value:'allow'})].concat(common)},
    {key:'walled_garden_ip',label:'Walled Garden IP List',singular:'Walled garden IP rule',columns:['dst_address','protocol','dst_port','server','action'],fields:[server,field('dst_address','Destination IP or subnet','cidr',{required:true}),field('protocol','Protocol','select',{options:['any','tcp','udp','icmp'],value:'any'}),field('dst_port','Destination ports','ports',{placeholder:'80,443'}),field('action','Action','select',{options:['allow','deny'],value:'allow'})].concat(common)},
    {key:'cookies',label:'Cookies',singular:'Cookie',live:true,columns:['user','server','mac_address','expires_at']}
];
var labels = { name:'Name',interface:'Interface',address_pool:'Address pool',profile:'Profile',addresses_per_mac:'Addresses / MAC',hotspot_address:'Hotspot address',dns_name:'DNS name',http_port:'Login port',cookie_login:'Remember sign-in',shared_users:'Concurrent sessions',session_timeout:'Session timeout',idle_timeout:'Idle timeout',rate_limit_up:'Upload speed',rate_limit_down:'Download speed',user:'User',server:'Server',address:'IP address',mac_address:'MAC address',uptime:'Uptime',bytes_in:'Downloaded',bytes_out:'Uploaded',authorized:'Signed in',state:'State',limit_uptime:'Time limit',type:'Access',protocol:'Protocol',ports:'Ports',host:'Host name',port:'Port',action:'Action',dst_address:'Destination',dst_port:'Ports',expires_at:'Expires' };
function isIP(value) { return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(function(s){return +s <= 255;}); }
function validate(schema, values, editing) {
    var result = {}, errors = {};
    schema.fields.forEach(function(f) {
        var v = values[f.key];
        if (f.type === 'checkbox') { result[f.key] = !!v; return; }
        v = v == null ? '' : String(v);
        if (f.type !== 'password') v = v.trim();
        if ((f.required || (f.type === 'password' && !editing)) && !v) errors[f.key] = 'Enter '+f.label.toLowerCase()+'.';
        if (f.max && f.type !== 'number' && v.length > f.max) errors[f.key] = 'Use '+f.max+' characters or fewer.';
        if (v && /[\x00-\x1f\x7f]/.test(v)) errors[f.key] = 'Control characters are not allowed.';
        if (f.type === 'number') {
            if (!/^\d+$/.test(v) || !Number.isSafeInteger(+v) || +v < (f.min || 0) || +v > (f.max || Number.MAX_SAFE_INTEGER)) errors[f.key] = 'Enter a whole number from '+(f.min || 0)+' to '+(f.max || Number.MAX_SAFE_INTEGER)+'.';
            else v = +v;
        }
        if (v && f.type === 'ip' && !isIP(v)) errors[f.key] = 'Enter a valid IPv4 address.';
        if (v && f.type === 'cidr') { var parts=v.split('/'); if (parts.length>2 || !isIP(parts[0]) || (parts.length===2 && (!/^(0|[1-9]\d?)$/.test(parts[1]) || +parts[1]>32))) errors[f.key]='Enter a valid IPv4 address or subnet.'; }
        if (v && f.type === 'hostname' && !(new RegExp('^(?:'+(f.wildcard ? '\\*\\.' : '')+'|)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$')).test(v)) errors[f.key]='Enter a valid host name.';
        if (v && f.type === 'mac' && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(v)) errors[f.key]='Use a MAC address such as AA:BB:CC:DD:EE:FF.';
        if (v && f.type === 'ports' && !v.split(',').every(function(item){var p=item.trim().split('-');return p.length<=2 && p.every(function(n){return /^\d{1,5}$/.test(n) && +n>=1 && +n<=65535;}) && (p.length===1 || +p[0]<=+p[1]);})) errors[f.key]='Enter ports from 1 to 65535, separated by commas, or a range such as 8000-8080.';
        result[f.key]=v;
    });
    if (schema.key==='walled_garden_ip' && result.dst_port && ['tcp','udp'].indexOf(result.protocol)<0) errors.dst_port='Choose TCP or UDP when specifying ports.';
    if (schema.key==='ip_bindings' && !result.address && !result.mac_address) errors.address='Enter an IP address, subnet or MAC address.';
    if ((schema.key==='servers'||schema.key==='setup') && result.address_pool && (!/\/\d+$/.test(result.address_pool)||+result.address_pool.split('/')[1]<1||+result.address_pool.split('/')[1]>30)) errors.address_pool='Use a subnet with a prefix length from 1 to 30, such as 10.42.0.0/24.';
    return {record:result,errors:errors};
}
function duration(value) { var n=Number(value); if (!Number.isFinite(n)) return String(value || '—'); if (n<60) return n+'s'; if(n<3600)return Math.floor(n/60)+'m '+Math.floor(n%60)+'s'; if(n<86400)return Math.floor(n/3600)+'h '+Math.floor(n%3600/60)+'m'; return Math.floor(n/86400)+'d '+Math.floor(n%86400/3600)+'h'; }
function bytes(value) { var n=Number(value); if(!Number.isFinite(n))return '—'; var units=['B','KiB','MiB','GiB','TiB'],i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return (i?n.toFixed(1):n)+' '+units[i]; }
return baseclass.extend({schemas:schemas,labels:labels,validate:validate,isIP:isIP,duration:duration,bytes:bytes});
