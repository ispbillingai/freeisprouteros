const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = new Function('baseclass', fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/wifi-data.js', 'utf8'))({extend: x => x});
const profile = {label:'Office', encryption:'sae', key:'test password 123', ieee80211w:'2', wpa_group_rekey:'3600'};
const radio = {'.name':'radio0', '.type':'wifi-device', type:'mac80211', band:'5g'};
const target = {'.name':'ap0', '.type':'wifi-iface', device:'radio0', mode:'ap', ssid:'Office', network:['lan'], encryption:'psk2', key:'previous test key', disabled:'1', wps_pushbutton:'1'};
const all = () => true;
const plan = (p={}, t={}, r={}, feature=all) => data.plan({...profile,...p}, [{...target,...t}], [{...radio,...r}], feature);
let count=0;
function rejects(fn, message) { assert.throws(fn, message); count++; }
assert.equal(data.validate(profile), true);
for(const encryption of Object.keys(data.modes)) assert.equal(data.validate({...profile,encryption}),true);
rejects(()=>plan({label:' '}), /name/);
rejects(()=>plan({label:'a'.repeat(65)}), /name/);
rejects(()=>plan({encryption:'wpa2'}), /security mode/);
rejects(()=>plan({encryption:'toString'}), /security mode/);
for(const key of ['', 'short', 'a'.repeat(64), 'password\n123', 'sécurité123']) rejects(()=>plan({key}), /passphrase/);
assert.equal(plan({encryption:'psk2',key:'a'.repeat(64)}).length,1);
for(const ieee80211w of ['', '3', '0','1']) rejects(()=>plan({ieee80211w}), /protection/);
rejects(()=>plan({encryption:'sae-mixed',ieee80211w:'0'}), /protection/);
assert.equal(plan({encryption:'sae-mixed',ieee80211w:'1'}).length,1);
for(const wpa_group_rekey of ['0','-1','1.5','1e4','1000000000','3600;reboot']) rejects(()=>plan({wpa_group_rekey}), /seconds/);
assert.equal(plan({wpa_group_rekey:''}).length,1);
rejects(()=>data.plan(profile, [], [radio],all), /Select/);
rejects(()=>data.plan(profile, [target,target], [radio],all), /selection/);
rejects(()=>data.plan(profile, [null], [radio],all), /selection/);
rejects(()=>data.plan(profile, [target], [],all), /driver/);
rejects(()=>plan({}, {}, {type:'other'}), /driver/);
rejects(()=>plan({}, {mode:'adhoc'}), /other modes/);
rejects(()=>plan({}, {}, {}, ()=>false), /service/);
rejects(()=>plan({}, {}, {}, (service, flag)=>!flag), /WPA3/);
rejects(()=>plan({encryption:'owe'}, {}, {}, (service, flag)=>flag!=='owe'), /OWE/);
rejects(()=>plan({encryption:'psk2'},{mode:'mesh'}), /Mesh/);
rejects(()=>plan({},{mode:'mesh'},{},(service, flag)=>flag!=='mesh'), /Mesh/);
assert.equal(plan({}, {mode:'mesh'}).length,1);
const requested=[];
plan({}, {mode:'sta'}, {}, (service, flag)=>{requested.push([service,flag]);return true;});
assert(requested.every(x=>x[0]==='wpasupplicant'));
for(const encryption of ['psk2','sae-mixed']) rejects(()=>plan({encryption},{},{band:'6g'}), /6 GHz/);
assert.equal(plan({}, {}, {band:'6g'}).length,1);
for(const encryption of ['wep-open','wpa2','psk','psk2+tkip']) rejects(()=>plan({}, {encryption}), /legacy or enterprise/);
for(const key of ['auth_server','acct_server','eap_type','key1','sae_password','wpa_psk_file','owe_transition_ifname']) rejects(()=>plan({}, {[key]:'present'}), /advanced security/);
rejects(()=>plan({}, {ppsk:'1'}), /advanced security/);
rejects(()=>plan({encryption:'owe'}, {ieee80211r:'1'}), /fast transition/);
const before=JSON.stringify(target), changes=plan();
assert.equal(JSON.stringify(target),before,'Planning is pure');
assert.deepEqual(changes[0].values,{encryption:'sae',ieee80211w:'2',key:profile.key,wpa_group_rekey:'3600'});
let persisted=JSON.parse(before);
for(const k of changes[0].unset) delete persisted[k];
Object.assign(persisted,changes[0].values);
persisted=JSON.parse(JSON.stringify(persisted));
assert.equal(persisted.key,profile.key);
assert.equal(persisted.ssid,target.ssid);
assert.deepEqual(persisted.network,target.network);
assert.equal(persisted.disabled,'1');
assert.equal(persisted.wps_pushbutton,undefined);
const owe=plan({encryption:'owe',key:'',wpa_group_rekey:''})[0];
assert(owe.unset.includes('key')); assert(owe.unset.includes('wpa_group_rekey')); assert(!('key' in owe.values));
// A bad second target must not produce a partial plan or modify the first.
rejects(()=>data.plan(profile,[target,{...target,'.name':'bad',mode:'unsupported'}],[radio],all),/other modes/);
assert.equal(JSON.stringify(target),before);
for(const kind of ['menu','acl']) {
 const p=kind==='menu'?'openwrt/files/usr/share/luci/menu.d/luci-app-freeisp-wifi.json':'openwrt/files/usr/share/rpcd/acl.d/luci-app-freeisp-wifi.json';
 const definition=JSON.parse(fs.readFileSync(p,'utf8'));
 if(kind==='menu') {assert.equal(definition['admin/wifi/interfaces'].action.path,'network/wireless');assert(!definition['admin/wifi'].depends.uci);}
 else {assert.deepEqual(definition['luci-app-freeisp-wifi'].write,{uci:['wireless','freeisp_wifi']});assert(!definition['luci-app-freeisp-wifi'].read.file);}
}
console.log(`WiFi: ${count} invalid-input/capability cases, profile planning, field preservation and ACL/menu checks passed.`);
