/* Development fixture only. The production view always reads freeisp.hotspot. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const resources = path.join(root, 'openwrt/files/www/luci-static/resources');
function seed() {
    return {revision:'revision-1',can_write:true,interfaces:[{name:'guest',eligible:true},{name:'guest2',eligible:true},{name:'wan',eligible:false,reason:'Internet interface'},{name:'lan',eligible:false,reason:'Management interface'}],runtime:{available:true,error:''},collections:{
        servers:[{id:'server1',name:'Guest hotspot',interface:'guest',address_pool:'10.42.0.0/24',profile:'sp1',addresses_per_mac:2,disabled:false,comment:'Guest portal'}],
        server_profiles:[{id:'sp1',name:'Guest sign-in',hotspot_address:'10.42.0.1',dns_name:'login.example.com',http_port:6480,cookie_login:true,cookie_lifetime:86400,disabled:false,comment:''}],
        users:[{id:'user1',name:'alice',password_set:true,profile:'up1',server:'all',mac_address:'',limit_uptime:0,limit_bytes_in:0,limit_bytes_out:0,disabled:false,comment:''}],
        user_profiles:[{id:'up1',name:'Guest plan',shared_users:1,session_timeout:0,idle_timeout:300,rate_limit_up:0,rate_limit_down:0,disabled:false,comment:''}],
        active:[{id:'session1',user:'alice',server:'server1',address:'10.42.0.10',mac_address:'02:00:00:00:00:10',uptime:125,bytes_in:2048,bytes_out:1024}],
        hosts:[{id:'host1',address:'10.42.0.10',mac_address:'02:00:00:00:00:10',server:'server1',authorized:true,uptime:125,bytes_in:2048,bytes_out:1024}],
        ip_bindings:[{id:'bind1',address:'10.42.0.25',mac_address:'',server:'all',type:'bypassed',disabled:false,comment:''}],
        service_ports:[{id:'port1',name:'Guest DNS',protocol:'udp',ports:'53',disabled:false,comment:''}],
        walled_garden:[{id:'wg1',server:'all',host:'example.com',port:443,action:'allow',disabled:false,comment:''}],
        walled_garden_ip:[{id:'wgi1',server:'all',dst_address:'192.0.2.0/24',protocol:'tcp',dst_port:'443',action:'allow',disabled:false,comment:''}],
        cookies:[{id:'cookie1',user:'alice',server:'server1',mac_address:'02:00:00:00:00:10',expires_at:1893456000}]
    }};
}
function browserHarness(initial, options) {
    const fixture=window.hsFixture={state:initial,calls:[],failure:null,snapshotFailure:options.snapshotFailure||null,delay:0,sequence:1,polls:[],options};
    const copy=value=>JSON.parse(JSON.stringify(value));
    window.E=function(tag,attrs,children){
        const node=document.createElement(tag);if(attrs&&!Array.isArray(attrs)&&!(attrs instanceof Node)&&typeof attrs==='object'){Object.entries(attrs).forEach(([key,value])=>{if(typeof value==='function')node.addEventListener(key,value);else if(value!==false&&value!==null&&value!==undefined)node.setAttribute(key,value===true?'':String(value));});}else{children=attrs;}
        function add(child){if(child==null)return;if(Array.isArray(child))child.forEach(add);else node.appendChild(child instanceof Node?child:document.createTextNode(String(child)));}add(children);return node;
    };
    window.L={resource:p=>'/resources/'+p,hasViewPermission:()=>!options.readOnly};
    window.baseclass={extend:v=>v};window.view={extend:v=>v};
    window.poll={add:(fn,seconds)=>fixture.polls.push({fn,seconds})};
    window.ui={showModal:(title,children)=>{document.querySelector('dialog')?.remove();const node=E('dialog',{'aria-label':title},[E('h3',{},title),children]);document.body.appendChild(node);node.showModal();node.addEventListener('cancel',e=>e.preventDefault());},hideModal:()=>document.querySelector('dialog')?.remove()};
    window.rpc={declare:definition=>async(...args)=>{
        if(fixture.delay)await new Promise(resolve=>setTimeout(resolve,fixture.delay));
        if(definition.method==='snapshot'){if(fixture.snapshotFailure)throw new Error(fixture.snapshotFailure);return copy(fixture.state);}
        const [action,encoded]=args,payload=JSON.parse(encoded);fixture.calls.push({action,payload});
        if(fixture.failure){const error=fixture.failure;fixture.failure=null;return {ok:false,error};}
        if(options.readOnly||fixture.state.can_write===false)return {ok:false,error:{code:'permission_denied',message:'Read-only access.'}};
        if(payload.revision!==fixture.state.revision)return {ok:false,error:{code:'stale_revision',message:'Settings changed in another window.'}};
        const rows=fixture.state.collections[payload.collection];
        if(action==='save'){
            const record=copy(payload.record),index=rows.findIndex(r=>r.id===record.id);if(!record.id)record.id='new-'+(++fixture.sequence);if(payload.collection==='users'){record.password_set=!!record.password||index>=0&&rows[index].password_set;delete record.password;}if(index>=0)rows[index]=record;else rows.push(record);
        } else if(action==='remove') fixture.state.collections[payload.collection]=rows.filter(r=>!payload.ids.includes(r.id));
        else if(action==='set_enabled') rows.filter(r=>payload.ids.includes(r.id)).forEach(r=>r.disabled=!payload.enabled);
        else if(action==='disconnect') fixture.state.collections.active=fixture.state.collections.active.filter(r=>!payload.ids.includes(r.id));
        else if(action==='remove_cookies') fixture.state.collections.cookies=fixture.state.collections.cookies.filter(r=>!payload.ids.includes(r.id));
        else if(action==='setup'){fixture.state.collections.servers.push({id:'setup-'+(++fixture.sequence),name:payload.name,interface:payload.interface,address_pool:payload.address_pool,profile:'sp1',addresses_per_mac:2,disabled:false});}
        else if(action!=='reset_html')throw new Error('Unknown fixture action: '+action);
        fixture.state.revision='revision-'+(++fixture.sequence);return {ok:true,revision:fixture.state.revision};
    }};
}
function html(options={}) {
    const data=fs.readFileSync(path.join(resources,'freeisp/hotspot-data.js'),'utf8'),view=fs.readFileSync(path.join(resources,'view/freeisp/hotspot.js'),'utf8');
    return `<!doctype html><html lang="en" data-freeisp-theme="day"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hotspot UI fixture</title><style>:root{--fi-panel:#fff;--fi-input:#f5f9fc;--fi-text:#102b42;--fi-muted:#526c80;--fi-line:#d8e5ed;--fi-accent:#008b91;--fi-tint:#e0f7f5;--fi-button:#007e84;--fi-button-text:#fff}:root[data-freeisp-theme=night]{color-scheme:dark;--fi-panel:#142b3a;--fi-input:#1b3545;--fi-text:#e7f3f8;--fi-muted:#a0bdce;--fi-line:#2c495b;--fi-accent:#39e0d3;--fi-tint:#163f46;--fi-button:#39e0d3;--fi-button-text:#082631}body{margin:24px;background:var(--fi-input);color:var(--fi-text);font-family:Segoe UI,Arial,sans-serif}dialog{background:var(--fi-panel);color:var(--fi-text);border:1px solid var(--fi-line);border-radius:8px;padding:24px;width:min(680px,calc(100vw - 60px));max-height:90vh}dialog::backdrop{background:#06243899}dialog h3{margin:0 0 18px}input,button,select{font:inherit}*{box-sizing:border-box}</style></head><body><main id="app"></main><script>(${browserHarness.toString()})(${JSON.stringify(seed())},${JSON.stringify(options)});window.data=new Function('baseclass',${JSON.stringify(data)})(baseclass);window.hotspotView=new Function('view','rpc','ui','poll','data',${JSON.stringify(view)})(view,rpc,ui,poll,data);hotspotView.load().then(value=>document.querySelector('#app').appendChild(hotspotView.render(value)));</script></body></html>`;
}
async function start(options={}) {
    const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html(options));}else if(pathname==='/resources/freeisp/hotspot.css'){res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(resources,'freeisp/hotspot.css')));}else{res.statusCode=404;res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={start,seed};
if(require.main===module)start().then(fixture=>console.log(fixture.url));
