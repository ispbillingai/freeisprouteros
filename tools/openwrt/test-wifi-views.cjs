// Executes the production view handlers against explicit LuCI/ubus test doubles.
// This checks UI behavior and staging, not radio operation or router persistence.
const assert=require('node:assert/strict'), fs=require('node:fs');
class Node {
 constructor(tag,attrs,children){this.tag=tag;this.attrs=attrs||{};this.children=[];this._text='';this.checked=false;this.disabled=!!this.attrs.disabled;this.append(children);}
 append(v){if(Array.isArray(v))v.forEach(x=>this.append(x));else if(v!=null)this.children.push(v);}
 appendChild(v){this.children.push(v);return v;}
 set textContent(v){this.children=[];this._text=String(v);}
 get textContent(){return this._text+this.children.map(x=>x instanceof Node?x.textContent:String(x)).join(' ');}
}
function E(tag,attrs,children){return new Node(tag,attrs,children);}
function find(node,predicate){if(!(node instanceof Node))return [];return (predicate(node)?[node]:[]).concat(node.children.flatMap(n=>find(n,predicate)));}
function moduleFile(file,scope){return new Function(...Object.keys(scope),fs.readFileSync(file,'utf8'))(...Object.values(scope));}
const data=moduleFile('openwrt/files/www/luci-static/resources/freeisp/wifi-data.js',{baseclass:{extend:x=>x}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const profile={'.name':'p0','.type':'profile',label:'Office',encryption:'sae',key:'test-password',ieee80211w:'2'};
const iface={'.name':'ap0','.type':'wifi-iface',mode:'ap',device:'radio0',ssid:'My WiFi',network:['lan'],encryption:'psk2',key:'old-password'};
const radio={'.name':'radio0','.type':'wifi-device',type:'mac80211',band:'5g'};
function fixture(){
 const f={state:{freeisp_wifi:{p0:{...profile}},wireless:{radio0:{...radio},ap0:{...iface}}},writes:[],modal:null,notices:[],saved:0,applied:0,readonly:false,pending:{},failure:false};
 f.uci={load:async()=>{},get:(c,s)=>f.state[c][s],sections:(c,t)=>Object.values(f.state[c]).filter(s=>s['.type']===t),changes:async()=>f.pending,
 set:(c,s,k,v)=>{f.writes.push([c,s,k]);f.state[c][s][k]=v;},unset:(c,s,k)=>{f.writes.push([c,s,k]);delete f.state[c][s][k];},save:async()=>{if(f.failure)throw Error('Backend save failed');f.saved++;f.persisted=JSON.stringify(f.state);}};
 f.ui={showModal:(title,children)=>f.modal=E('div',{},children),hideModal:()=>f.modal=null,addNotification:(a,node)=>f.notices.push(node.textContent),changes:{init:async()=>{},apply:()=>f.applied++}};
 f.L={hasViewPermission:()=>!f.readonly,hasSystemFeature:()=>true};
 f.view=moduleFile('openwrt/files/www/luci-static/resources/view/freeisp/wifi-profiles.js',{view:{extend:x=>x},form:{},uci:f.uci,ui:f.ui,data,E,L:f.L});
 f.map={save:async()=>{f.mapSaved=true;}};
 f.open=()=>f.view.chooseInterfaces(f.map,'p0');
 f.stage=async()=>{find(f.modal,n=>n.tag==='input').forEach(n=>n.checked=true);const b=find(f.modal,n=>n.textContent==='Stage security changes')[0];await b.attrs.click();};
 return f;
}
(async()=>{
 let f=fixture();await f.open();assert(f.modal);assert(!f.modal.textContent.includes(profile.key));await f.stage();assert.equal(f.saved,1);assert.equal(f.applied,0);assert.equal(f.modal,null);
 assert.equal(JSON.parse(f.persisted).wireless.ap0.encryption,'sae');assert.deepEqual(JSON.parse(f.persisted).wireless.ap0.network,['lan']);
 assert(f.notices.some(n=>n.includes('Save & Apply')));
 f=fixture();f.readonly=true;await f.open();assert(!f.modal);assert.equal(f.writes.length,0);assert(f.notices[0].includes('read-only'));
 f=fixture();await f.open();f.pending={wireless:[['set','ap0','ssid','other']]};await f.stage();assert.equal(f.writes.length,0);assert(f.modal.textContent.includes('pending WiFi'));
 f=fixture();await f.open();f.readonly=true;await f.stage();assert.equal(f.writes.length,0);
 f=fixture();f.state.wireless.bad={...iface,'.name':'bad',encryption:'wpa2'};await f.open();await f.stage();assert.equal(f.writes.length,0);assert(f.modal.textContent.includes('enterprise'));
 f=fixture();await f.open();f.failure=true;await f.stage();assert.equal(f.saved,0);assert.equal(f.applied,0);assert(f.modal.textContent.includes('Backend save failed'));assert(!f.notices.some(n=>n.includes('Profile copied')));
 f=fixture();await f.open();f.ui.hideModal();assert.equal(f.writes.length,0);
 f=fixture();delete f.state.wireless.ap0;await f.open();assert(find(f.modal,n=>n.textContent==='Stage security changes')[0].disabled);
 // Status pages, including no-radio, down-radio, service failure and refresh failure.
 function status(page, options={}) {
  const ctx={...fixture(),poller:null,fail:options.fail,networkFail:false,calls:[]};
  const net={getName:()=> 'ap0',getIfname:()=> 'phy0-ap0',getWifiDeviceName:()=> 'radio0',isUp:()=>!options.down,getSSID:()=>'<script>literal SSID</script>',getChannel:()=>36,getVlans:()=>options.vlans?[{getIfname:()=> 'phy0-ap0.10'}]:[]};
  const device={getName:()=> 'radio0',isUp:()=>false};
  ctx.rpc={declare:spec=>(...args)=>{ctx.calls.push([spec.method,...args]);assert.equal(spec.reject,true);return ctx.fail?Promise.reject(Error('Disconnected')):Promise.resolve(spec.method==='freqlist'?[{channel:36,mhz:5180,restricted:false}]:[{mac:'00:11:22:33:44:55',signal:0,noise:-95,rx:{rate:144000},tx:{rate:72000},inactive:0}]);}};
  ctx.network={flushCache:async()=>{if(ctx.networkFail)throw Error('Network unavailable');},getWifiNetworks:async()=>options.empty?[]:[net]};
  const v=moduleFile('openwrt/files/www/luci-static/resources/view/freeisp/wifi-status.js',{view:{extend:x=>x},uci:ctx.uci,network:ctx.network,rpc:ctx.rpc,ui:ctx.ui,poll:{add:fn=>ctx.poller=fn},dom:{content:(node,child)=>{node.children=[];node._text='';node.append(child);}},E,L:{env:{requestpath:['admin','wifi',page]},url:(...parts)=>'/cgi-bin/luci/'+parts.join('/')}});
  ctx.root=v.render(options.empty?[[],[]]:[[device],[net]]);return ctx;
 }
 for(const page of ['channels','access','registration','connect','tools']){const s=status(page,{empty:true});await settle();assert(s.root.textContent.includes('No WiFi radios configured'));}
 let s=status('channels');await settle();assert(s.root.textContent.includes('5180 MHz'));assert(s.root.textContent.includes('Down'));
 s=status('channels',{fail:true});await settle();assert(s.root.textContent.includes('Channel information is unavailable'));
 s=status('registration');await settle();assert(s.root.textContent.includes('144.0 Mbit/s'));assert(s.root.textContent.includes('0 dBm'));assert(s.root.textContent.includes('0 ms'));
 assert(s.root.textContent.includes('<script>literal SSID</script>'),'SSID remains a text child');
 s.networkFail=true;await s.poller();assert(s.root.textContent.includes('previous successful refresh'));assert(s.root.textContent.includes('00:11:22:33:44:55'));
 s=status('registration',{fail:true});await settle();assert(s.root.textContent.includes('could not be read'));assert(s.root.textContent.includes('Unavailable: phy0-ap0'));
 s=status('registration',{vlans:true});await settle();assert.deepEqual(s.calls,[['assoclist','phy0-ap0'],['assoclist','phy0-ap0.10']]);assert(s.root.textContent.includes('phy0-ap0.10'));
 s=status('registration',{down:true});await settle();assert.equal(s.calls.length,0);assert(s.root.textContent.includes('No associated clients'));
 console.log('WiFi view handlers: staging, serialized test-store reload, no implicit apply, permissions, cancellation, atomic validation, save failures, empty states and failed/stale status tests passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
