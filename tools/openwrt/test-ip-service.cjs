const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const data = new Function('baseclass', read('openwrt/files/www/luci-static/resources/freeisp/ip-service-data.js'))({extend:v=>v});
const ok = values => ({ok:true,values}), failed = {ok:false,values:{}};
function snapshot() {
    const s = {runtime:{},
        freeisp_api:ok({main:{'.type':'service',enabled:'1',port:'8728',listen_address:'0.0.0.0'}}),
        freeisp_ftp:ok({main:{'.type':'service',enabled:'1',port:'21',listen_address:'0.0.0.0'}}),
        dropbear:ok({main:{'.type':'dropbear',Port:'22'}}),
        uhttpd:ok({main:{'.type':'uhttpd',listen_http:['0.0.0.0:80','[::]:80'],listen_https:['0.0.0.0:443','[::]:443']}})};
    for(const n of ['freeisp-api','freeisp-ftp','dropbear','uhttpd']) s.runtime[n]=ok({[n]:{instances:{main:{running:true}}}});
    return s;
}
const row=(s,id)=>data.rows(s).find(r=>r.id===id);
test('inventory permissions stay read-only; settings writes are scoped to API and FTP',()=>{
    const menu=JSON.parse(read('openwrt/files/usr/share/luci/menu.d/luci-app-freeisp-ip-service.json'));
    const acl=JSON.parse(read('openwrt/files/usr/share/rpcd/acl.d/luci-app-freeisp-ip-service.json'));
    assert.equal(menu['admin/network/freeisp_ip_service'].action.path,'freeisp/ip-service');
    assert.equal(acl['luci-app-freeisp-ip-service'].write,undefined);
    assert.deepEqual(acl['luci-app-freeisp-ip-service'].read.ubus,{service:['list']});
    assert.deepEqual(acl['luci-app-freeisp-ip-service-settings'].write,{uci:['freeisp_api','freeisp_ftp']});
    for(const n of ['api','ftp']) assert.equal(menu['admin/network/freeisp_'+n+'_settings'].action.path,'freeisp/'+n+'-settings');
});
test('five real services report default ports and actual process state',()=>{
    const rows=data.rows(snapshot());
    assert.deepEqual(rows.map(r=>r.name),['API','FTP','SSH','FreeISP Desk','WWW']);
    assert.deepEqual(rows.map(r=>r.ports),['8728','21','22','80, 443','80, 443']);
    assert(rows.every(r=>r.state==='running'));
});
test('stopped, disabled and pending-disable states reflect the actual process',()=>{
    const s=snapshot();s.runtime['freeisp-api']=ok({});s.runtime['freeisp-ftp']=ok({});s.freeisp_ftp.values.main.enabled='0';
    assert.equal(row(s,'api').state,'stopped');assert.equal(row(s,'ftp').state,'disabled');assert.equal(row(s,'ftp').ports,'21');
    s.runtime['freeisp-ftp']=snapshot().runtime['freeisp-ftp'];
    assert.equal(row(s,'ftp').state,'running');assert.equal(row(s,'ftp').listeners[0].disabled,true);
});
test('partial read failures show Unknown without false stopped claims or invented ports',()=>{
    const s=snapshot();s.freeisp_api=failed;s.runtime['freeisp-ftp']=failed;s.uhttpd=failed;
    for(const id of ['api','ftp','desk','www']) assert.equal(row(s,id).state,'unknown');
    assert.equal(row(s,'api').ports,'—');assert.equal(row(s,'ftp').ports,'21');assert.equal(row(s,'desk').ports,'—');assert.equal(row(s,'ssh').state,'running');
});
test('absent configurations never invent default listeners',()=>{
    const s=snapshot();for(const c of ['freeisp_api','freeisp_ftp','dropbear','uhttpd'])s[c]=ok({});for(const n of Object.keys(s.runtime))s.runtime[n]=ok({});
    assert(data.rows(s).every(r=>r.state==='unconfigured'&&r.ports==='—'));
});
test('custom service ports and multiple SSH instances are preserved',()=>{
    const s=snapshot();s.freeisp_api.values.main.port='18728';s.freeisp_ftp.values.main.port='2121';
    s.dropbear=ok({lan:{'.type':'dropbear',Port:'2222',Interface:'lan'},backup:{'.type':'dropbear',Port:'2200',enable:'0',DirectInterface:'eth2'}});
    assert.equal(row(s,'api').ports,'18728');assert.equal(row(s,'ftp').ports,'2121');assert.equal(row(s,'ssh').ports,'2222, 2200');assert.equal(row(s,'ssh').addresses,'lan, eth2');assert.equal(row(s,'ssh').listeners[1].disabled,true);
    s.dropbear=ok({main:{'.type':'dropbear'}});assert.equal(row(s,'ssh').ports,'22');
});
test('Desk and WWW share deduplicated ports and honor disabled web configuration',()=>{
    const s=snapshot();assert.equal(row(s,'desk').ports,row(s,'www').ports);assert.equal(row(s,'www').listeners.length,4);
    s.uhttpd.values.main.enabled='0';s.runtime.uhttpd=ok({});assert.equal(row(s,'www').state,'disabled');
    s.uhttpd.values.main.listen_http='malformed';assert.equal(row(s,'www').listeners[0].port,'Unknown');
});
test('RPC independently reads four configurations and four service states; never writes',async()=>{
    const calls=[],s=snapshot(),rpc={declare:spec=>async name=>{calls.push([spec.object,spec.method,name]);assert.equal(spec.reject,true);if(name==='freeisp-api')throw Error('denied');return spec.object==='uci'?s[name].values:s.runtime[name].values;}};
    const v=new Function('view','rpc','ui','data','E','L',read('openwrt/files/www/luci-static/resources/view/freeisp/ip-service.js'))({extend:v=>v},rpc,{},data,null,{});
    const loaded=await v.load();assert.equal(calls.length,8);assert(calls.every(([o,m])=>o==='uci'&&m==='get'||o==='service'&&m==='list'));assert.equal(row(loaded,'api').state,'unknown');assert.equal(row(loaded,'ftp').state,'running');assert.equal(v.handleSaveApply,null);
});
test('FTP form rejects reversed passive ranges and overlapping control ports',()=>{
    const fields={},form={NamedSection:{},Flag:{},Value:{},Map:function(){this.section=()=>({option:(_,key)=>fields[key]={formvalue:()=>fields[key].value}});this.render=()=>fields;}};
    new Function('view','form',read('openwrt/files/www/luci-static/resources/view/freeisp/ftp-settings.js'))({extend:v=>v},form).render();
    fields.passive_min_port.value='50000';fields.port.value='21';assert.equal(fields.passive_max_port.validate('main','50009'),true);assert.match(fields.passive_max_port.validate('main','49999'),/at least/);fields.port.value='50005';assert.match(fields.passive_max_port.validate('main','50009'),/outside/);assert.notEqual(fields.passive_max_port.validate('main','65536'),true);
});
