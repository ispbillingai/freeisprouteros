// Browser rendering/interaction checks with explicit fake ubus/UCI responses.
// Run with Playwright installed or NODE_PATH pointing to the bundled runtime.
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {chromium}=require('playwright');
const base='openwrt/files/www/luci-static/';
const source={status:fs.readFileSync(base+'resources/view/freeisp/wifi-status.js','utf8'),profiles:fs.readFileSync(base+'resources/view/freeisp/wifi-profiles.js','utf8'),data:fs.readFileSync(base+'resources/freeisp/wifi-data.js','utf8'),nav:fs.readFileSync(base+'freeisp/wifi-navigation.js','utf8')};
const css=fs.readFileSync(base+'freeisp/cascade.css','utf8').replace(/^@import[^;]+;/,'')+fs.readFileSync(base+'resources/freeisp/wifi.css','utf8');
(async()=>{
 const browser=await chromium.launch({channel:process.env.WIFI_BROWSER_CHANNEL||'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body><main id="maincontent"><div id="view"></div></main></body></html>'}));
  async function render(tab,night=false,empty=false){
   await page.goto('http://wifi.test/cgi-bin/luci/admin/wifi/'+tab);
   await page.addStyleTag({content:css});
   await page.evaluate(({source,tab,night,empty})=>{
    if(night)document.documentElement.dataset.freeispTheme='night';
    function E(tag,attrs={},children=[]){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(typeof v==='function')n.addEventListener(k,v);else if(v!=null&&v!==false){n.setAttribute(k,v===true?'':v);}}function add(c){if(Array.isArray(c))c.forEach(add);else if(c!=null)n.append(c instanceof Node?c:document.createTextNode(String(c)));}add(children);return n;}
    const net={getName:()=> 'ap0',getIfname:()=> 'phy0-ap0',getWifiDeviceName:()=> 'radio0',isUp:()=>true,getSSID:()=> 'Office WiFi',getChannel:()=>36};
    const radio={getName:()=> 'radio0',isUp:()=>true};
    const config={radio0:{'.name':'radio0','.type':'wifi-device',type:'mac80211',band:'5g',htmode:'HE80',channel:'36',country:'TR'},ap0:{'.name':'ap0','.type':'wifi-iface',device:'radio0',mode:'ap',ssid:'Office WiFi',encryption:'psk2',network:['lan'],macfilter:'allow',maclist:['00:11:22:33:44:55'],isolate:'1'},sta0:{'.name':'sta0','.type':'wifi-iface',device:'radio0',mode:'sta',ssid:'Upstream',encryption:'sae',network:['wan']}};
    const profile={'.name':'office',label:'Office security',encryption:'sae',key:'not-shown-secret',ieee80211w:'2'};
    const uci={load:async()=>{},get:(c,s)=>c==='freeisp_wifi'?profile:config[s],sections:(c,t)=>empty?[]:Object.values(config).filter(v=>v['.type']===t),changes:async()=>({}),set:(c,s,k,v)=>config[s][k]=v,unset:(c,s,k)=>delete config[s][k],save:async()=>{window.saved=JSON.parse(JSON.stringify(config));}};
    const ui={showModal:(title,nodes)=>{document.getElementById('view').replaceChildren(E('div',{'class':'modal'},[E('h2',{},title),nodes]));},hideModal:()=>{},addNotification:(title,node)=>document.getElementById('view').append(node),changes:{init:async()=>{}}};
    const L={env:{requestpath:['admin','wifi',tab]},url:(...p)=>'/cgi-bin/luci/'+p.join('/'),hasViewPermission:()=>true,hasSystemFeature:()=>true};
    const rpc={declare:spec=>async()=>spec.method==='freqlist'?[{channel:36,mhz:5180,restricted:false},{channel:52,mhz:5260,restricted:true}]:[{mac:'00:11:22:33:44:55',signal:-48,noise:-96,rx:{rate:866700},tx:{rate:720000},inactive:0}]};
    const scope={view:{extend:x=>x},uci,network:{flushCache:async()=>{},getWifiNetworks:async()=>empty?[]:[net]},rpc,ui,poll:{add:()=>{}},dom:{content:(n,c)=>n.replaceChildren(c)},E,L};
    if(tab==='profiles'){
     const data=new Function('baseclass',source.data)({extend:x=>x});
     const v=new Function(...Object.keys({...scope,form:{},data}),source.profiles)(...Object.values({...scope,form:{},data}));
     v.chooseInterfaces({save:async()=>{}},'office');
    } else {
     const v=new Function(...Object.keys(scope),source.status)(...Object.values(scope));
     document.getElementById('view').replaceChildren(v.render(empty?[[],[]]:[[radio],[net]]));
    }
    new Function(source.nav)();
   },{source,tab,night,empty});
   await page.waitForTimeout(80);
  }
  fs.mkdirSync('artifacts/wifi-ui',{recursive:true});
  for(const tab of ['channels','access','registration','connect','tools']){
   await render(tab);
   assert.equal(await page.getByRole('navigation',{name:'WiFi sections'}).getByRole('link').count(),7);
   await page.screenshot({path:`artifacts/wifi-ui/${tab}-day.png`,fullPage:true});
  }
  await render('profiles');
  assert(!(await page.locator('body').innerText()).includes('not-shown-secret'));
  await page.locator('input[type=checkbox]').first().check();
  await page.getByRole('button',{name:'Stage security changes'}).click();
  assert.equal(await page.evaluate(()=>window.saved.ap0.encryption),'sae');
  assert.equal(await page.evaluate(()=>window.saved.sta0.encryption),'sae');
  await page.screenshot({path:'artifacts/wifi-ui/profile-stage.png',fullPage:true});
  await render('channels',true);await page.screenshot({path:'artifacts/wifi-ui/channels-night.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await render('channels',true,true);
  assert((await page.locator('body').innerText()).includes('No WiFi radios configured'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'artifacts/wifi-ui/no-radio-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('WiFi browser fixtures: 7 tabs, profile staging, secret masking, day/night rendering and mobile empty state passed. No live router used.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
