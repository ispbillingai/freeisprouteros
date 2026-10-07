/* Actual navigation.js in a browser; LuCI and read-only router replies are fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const source = fs.readFileSync('openwrt/files/www/luci-static/freeisp/navigation.js', 'utf8');
const output = path.resolve('artifacts/tests/fast-navigation');
fs.mkdirSync(output, {recursive: true});
const env = route => ({sessionid:'fixture-session',scriptname:'/cgi-bin/luci',ubuspath:'/ubus/',nodespec:{satisfied:true,action:{type:'view',path:route}}});
const mock = `
const nativeFetch=window.fetch.bind(window);window.fetchLog=[];window.fetch=(url,options)=>{const entry={url:String(url),credentials:options&&options.credentials,cache:options&&options.cache};fetchLog.push(entry);return nativeFetch(url,options).then(response=>{const read=response.json.bind(response);response.json=()=>read().then(value=>{entry.decoded=true;return value;});return response;});};
const actualNow=Date.now.bind(Date);window.clockOffset=0;Date.now=()=>actualNow()+clockOffset;
window.fixture={loads:{},renders:[],pollRuns:[],removed:0,uciUnloads:[],mutations:[],flushes:0,defers:{},resolvers:{},renderDefers:{},renderResolvers:{},dirty:false,applied:[],sharedPoll:false,scripts:[],scriptEvents:[],documentId:Math.random().toString(36)};
window.L={loaded:true,env:${JSON.stringify(env('freeisp'))},view:function(){},Poll:{callbacks:new Set(),add(fn){this.callbacks.add(fn);return true;},remove(fn){if(this.callbacks.delete(fn))fixture.removed++;return true;},start(){}},dom:{content(node,children){node.replaceChildren(children);},append(node,children){node.append(children);}},network:{flushCache(){fixture.flushes++;return Promise.resolve();}}};
L.view.prototype.__init__=function(){};
const cache={},uci={loaded:{network:true},unload(keys){fixture.uciUnloads.push(keys);this.loaded={};},set(){fixture.mutations.push('set');},save(){fixture.mutations.push('save');},apply(){fixture.mutations.push('apply');}};
const shared=()=>{fixture.pollRuns.push('shared');};
function create(path){function View(){this.__init__();} View.prototype=Object.create(L.view.prototype);View.prototype.constructor=View;
View.prototype.load=function(){if(window.reportFixtureLoad)window.reportFixtureLoad(path,fixture.documentId);fixture.loads[path]=(fixture.loads[path]||0)+1;const result={value:path+':'+fixture.loads[path]};return fixture.defers[path]?new Promise(resolve=>fixture.resolvers[path]=()=>resolve(result)):Promise.resolve(result);};
View.prototype.render=function(data){const finish=()=>{fixture.renders.push(path);const script=document.createElement('script');fixture.scripts.push({path,node:script});script.addEventListener('load',()=>fixture.scriptEvents.push(path+':load'));script.addEventListener('error',()=>fixture.scriptEvents.push(path+':error'));const form=document.createElement('form');form.id='fixture-form';const input=document.createElement('input');input.id='fixture-input';input.value=data.value;input.addEventListener('input',()=>fixture.dirty=true);form.append(input);const poll=fixture.sharedPoll?shared:()=>fixture.pollRuns.push(path);L.Poll.add(poll,1);window.addEventListener('beforeunload',e=>{if(fixture.dirty)e.preventDefault();});document.addEventListener('uci-applied',()=>fixture.applied.push(path));return form;};return fixture.renderDefers[path]?new Promise(resolve=>fixture.renderResolvers[path]=()=>resolve(finish())):finish();};
View.prototype.addFooter=function(){return document.createElement('footer');};return new View();}
L.require=function(name){if(name==='uci')return Promise.resolve(uci);const route=name.slice(5).replace(/\\./g,'/');return Promise.resolve(cache[route]||(cache[route]=create(route)));};
window.startFixture=()=>{cache.freeisp=create('freeisp');};
`;
const requests=[];
let releaseManifest={revision:'a'.repeat(64)}, holdPermission=false;
const heldResponses=[];
const releaseRequests=()=>requests.filter(request=>request.path==='/luci-static/freeisp/release.json');
const html = route => `<!doctype html><title>Fixture ${route}</title><header><span class="brand"></span></header><div id="view"></div><script src="/luci-static/resources/luci.js?v=fixture"></script><script>var luci = new LuCI(${JSON.stringify(env(route))});</script>`;
const server = http.createServer((req,res)=>{
 requests.push({path:req.url,dest:req.headers['sec-fetch-dest'],method:req.method,cookie:req.headers.cookie});
 if(req.url==='/navigation.js'){res.setHeader('Content-Type','text/javascript');res.end(source);return;}
 if(req.url==='/luci-static/freeisp/release.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(releaseManifest));return;}
 if(req.url.startsWith('/luci-static/')){res.setHeader('Content-Type','text/javascript');res.end('');return;}
 const route=req.url.replace('/cgi-bin/luci/admin/','');
 if(req.headers['sec-fetch-dest']==='empty'){
  res.setHeader('Content-Type','text/html');
  if(holdPermission&&route==='system/package-manager'){heldResponses.push(res);return;}
  if(route==='system/system'){res.end('<input name="luci_password"><h1>Sign in again</h1>');return;}
  if(route==='system/freeisp_files'){res.end(html(route).replace('"nodespec":','"notnodespec":'));return;}
  if(route==='status/overview'){res.end(html(route).replace('\"type\":\"view\",\"path\":\"status/overview\"','\"type\":\"template\",\"path\":\"admin_status/index\"')+`<script>ui.instantiateView('status/index');</script>`);return;}
  res.end(html(route));return;
 }
 res.setHeader('Content-Type','text/html');
 if(route==='system/system'||route==='system/freeisp_files'){res.end('<h1 id="login">Sign in again</h1>');return;}
 res.end(`<!doctype html><title>Fixture</title><header><span class="brand"></span></header><div id="view"></div><script src="/luci-static/resources/luci.js?v=fixture"></script><script>${mock}</script><script src="/navigation.js"></script><script>startFixture();</script>`);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,...(process.env.FREEISP_BROWSER_CHANNEL?{channel:process.env.FREEISP_BROWSER_CHANNEL}:{})});
 const checks={};
 const issues=[];
 try{
  const page=await browser.newPage();const viewLoads=[];await page.exposeFunction('reportFixtureLoad',(route,documentId)=>viewLoads.push({route,documentId}));await page.context().addCookies([{name:'fixture_auth',value:'present',url:base}]);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ready=()=>page.waitForFunction(()=>document.querySelector('#view')?.dataset.freeispState==='ready');
  const navigate=route=>page.evaluate(route=>freeispNavigation.navigate('/cgi-bin/luci/admin/'+route),route);
  await page.goto(base+'/cgi-bin/luci/admin/freeisp');await ready();
  await page.waitForFunction(()=>fetchLog.some(request=>request.url==='/luci-static/freeisp/release.json'));
  assert.equal(releaseRequests().length,1);
  assert.equal(releaseRequests()[0].cookie,undefined);
  assert.equal(await page.evaluate(()=>fetchLog.find(request=>request.url==='/luci-static/freeisp/release.json').credentials),'omit');
  checks.release_check_at_startup_omits_credentials=true;
  await page.locator('#fixture-input').fill('unsaved');
  page.once('dialog',dialog=>dialog.dismiss());
  await navigate('network/freeisp_bridge');
  assert.equal(await page.locator('#fixture-input').inputValue(),'unsaved');
  assert.equal(await page.evaluate(()=>fixture.uciUnloads.length),0);
  checks.dirty_leave_cancel_preserves_form=true;
  page.once('dialog',dialog=>dialog.accept());
  await navigate('network/freeisp_bridge');await ready();
  await page.evaluate(()=>fixture.dirty=false);
  assert.equal(await page.locator('#fixture-input').inputValue(),'network/freeisp_bridge:1');
  assert.equal(await page.evaluate(()=>L.Poll.callbacks.size),1);
  assert.equal(await page.evaluate(()=>fixture.removed),1);
  await page.evaluate(()=>document.dispatchEvent(new Event('uci-applied')));
  assert.deepEqual(await page.evaluate(()=>fixture.applied),['network/freeisp_bridge']);
  checks.old_poll_and_uci_listener_removed=true;
  await page.evaluate(()=>{fixture.scripts[0].node.dispatchEvent(new Event('load'));fixture.scripts[0].node.dispatchEvent(new Event('error'));const last=fixture.scripts[fixture.scripts.length-1];last.node.dispatchEvent(new Event('load'));last.node.dispatchEvent(new Event('error'));});
  assert.deepEqual(await page.evaluate(()=>fixture.scriptEvents),['network/freeisp_bridge:load','network/freeisp_bridge:error']);
  checks.script_callbacks_only_run_for_current_view=true;
  await navigate('network/freeisp_bridge');await ready();
  assert.equal(await page.locator('#fixture-input').inputValue(),'network/freeisp_bridge:2');
  assert.deepEqual(await page.evaluate(()=>fixture.mutations),[]);
  checks.revisited_view_loads_fresh_without_saving=true;
  await page.evaluate(()=>{fixture.scriptEvents=[];fixture.scripts[1].node.dispatchEvent(new Event('load'));fixture.scripts[1].node.dispatchEvent(new Event('error'));});
  assert.deepEqual(await page.evaluate(()=>fixture.scriptEvents),[]);
  checks.deferred_script_load_and_error_detached_on_leave=true;
  await page.evaluate(()=>{fixture.defers['network/freeisp_pppoe']=true;freeispNavigation.navigate('/cgi-bin/luci/admin/network/freeisp_pppoe');});
  await page.waitForFunction(()=>!!fixture.resolvers['network/freeisp_pppoe']);
  await page.evaluate(()=>{freeispNavigation.navigate('/cgi-bin/luci/admin/network/freeisp_hotspot').then(()=>window.latestDone=true);});
  // A view load still in flight must not restore its old form over a newer menu.
  await page.evaluate(()=>fixture.resolvers['network/freeisp_pppoe']());
  await page.waitForFunction(()=>window.latestDone===true);await ready();
  assert.equal(await page.locator('#fixture-input').inputValue(),'network/freeisp_hotspot:1');
  assert(!await page.evaluate(()=>fixture.renders.includes('network/freeisp_pppoe')));
  assert.equal(await page.locator('.freeisp-sidebar a.active').innerText(),'Hotspot');
  checks.stale_completion_cannot_replace_latest_view=true;
  await page.locator('#fixture-input').fill('unsaved hotspot');
  const unloadsBeforeBack=await page.evaluate(()=>fixture.uciUnloads.length);
  const backDialog=page.waitForEvent('dialog');
  await page.evaluate(()=>history.back());
  await (await backDialog).dismiss();
  await page.waitForFunction(()=>location.pathname==='/cgi-bin/luci/admin/network/freeisp_hotspot');
  assert.equal(await page.locator('#fixture-input').inputValue(),'unsaved hotspot');
  assert.equal(await page.locator('.freeisp-sidebar a.active').innerText(),'Hotspot');
  assert.equal(await page.evaluate(()=>fixture.uciUnloads.length),unloadsBeforeBack);
  await page.evaluate(()=>fixture.dirty=false);
  checks.dirty_back_cancel_restores_current_url_and_form=true;
  assert.deepEqual(await page.evaluate(()=>fixture.mutations),[]);
  checks.navigation_never_writes_router_settings=true;
  await page.evaluate(()=>{fixture.renderDefers['network/routes']=true;freeispNavigation.navigate('/cgi-bin/luci/admin/network/routes');});
  await page.waitForFunction(()=>!!fixture.renderResolvers['network/routes']);
  await page.evaluate(()=>{freeispNavigation.navigate('/cgi-bin/luci/admin/network/freeisp_queues').then(()=>window.renderLatestDone=true);});
  await page.evaluate(()=>fixture.renderResolvers['network/routes']());
  await page.waitForFunction(()=>window.renderLatestDone===true);await ready();
  await page.evaluate(()=>{fixture.applied=[];document.dispatchEvent(new Event('uci-applied'));});
  await page.evaluate(()=>{fixture.scriptEvents=[];const old=fixture.scripts.find(s=>s.path==='network/routes');old.node.dispatchEvent(new Event('load'));old.node.dispatchEvent(new Event('error'));});
  assert.deepEqual(await page.evaluate(()=>fixture.scriptEvents),[]);
  checks.cancelled_async_render_cannot_install_script_callbacks=true;
  const survivingListeners=await page.evaluate(()=>fixture.applied);
  const survivingPolls=await page.evaluate(()=>L.Poll.callbacks.size);
  if(survivingPolls!==1||JSON.stringify(survivingListeners)!==JSON.stringify(['network/freeisp_queues']))issues.push('Cancelled async render registers stale poll/listener under the new active view.');else checks.cancelled_async_render_cannot_register_new_view_resources=true;
  // Callback references shared by cached modules must get a fresh lifecycle owner.
  await page.evaluate(()=>fixture.sharedPoll=true);
  await navigate('network/freeisp_firewall');await ready();
  await page.evaluate(async()=>{for(const fn of L.Poll.callbacks)await fn();});
  const before=await page.evaluate(()=>fixture.pollRuns.filter(x=>x==='shared').length);
  await navigate('network/freeisp_firewall');await ready();
  await page.evaluate(async()=>{for(const fn of L.Poll.callbacks)await fn();});
  const after=await page.evaluate(()=>fixture.pollRuns.filter(x=>x==='shared').length);
  if(after!==before+1)issues.push('Reusing a poll function on a new view leaves it owned by the cancelled view.');else checks.reused_poll_callback_gets_new_owner=true;
  assert.equal(releaseRequests().length,1);checks.release_checks_obey_30_second_ttl=true;
  const documentsBeforeOverview=requests.filter(request=>request.dest==='document').length;
  await navigate('status/overview');await ready();
  assert.equal(await page.locator('#fixture-input').inputValue(),'status/index:1');
  assert.equal(requests.filter(request=>request.dest==='document').length,documentsBeforeOverview);
  assert.deepEqual(await page.evaluate(()=>[typeof progressbar,typeof renderBox,typeof renderBadge]),['function','function','function']);
  checks.overview_template_uses_native_status_view_without_reload=true;
  const releaseCountBeforeInvalid=releaseRequests().length;
  releaseManifest={revision:'invalid<script>'};
  await page.evaluate(()=>clockOffset+=31000);
  await navigate('network/dhcp');await ready();
  assert.equal(releaseRequests().length,releaseCountBeforeInvalid+1);
  assert.equal(await page.locator('#fixture-input').inputValue(),'network/dhcp:1');
  assert.equal(requests.filter(request=>request.dest==='document').length,documentsBeforeOverview);
  checks.invalid_release_manifest_ignored_safely=true;
  const previousDocument=await page.evaluate(()=>fixture.documentId);
  releaseManifest={revision:'b'.repeat(64)};
  await page.evaluate(()=>clockOffset+=31000);
  const fullReload=page.waitForNavigation({waitUntil:'load'});
  await page.evaluate(()=>{freeispNavigation.navigate('/cgi-bin/luci/admin/network/dns');});
  await fullReload;await ready();
  assert.equal(new URL(page.url()).pathname,'/cgi-bin/luci/admin/network/dns');
  assert.notEqual(await page.evaluate(()=>fixture.documentId),previousDocument);
  assert(!viewLoads.some(load=>load.documentId===previousDocument&&load.route==='network/dns'));
  assert(releaseRequests().every(request=>request.cookie===undefined));
  checks.changed_revision_reloads_before_old_runtime_loads_target=true;
  await page.waitForFunction(()=>fetchLog.some(request=>request.url==='/luci-static/freeisp/release.json'&&request.decoded));
  const raceDocument=await page.evaluate(()=>fixture.documentId);
  releaseManifest={revision:'c'.repeat(64)};holdPermission=true;
  await page.evaluate(()=>{clockOffset+=31000;freeispNavigation.navigate('/cgi-bin/luci/admin/system/package-manager');});
  await page.waitForFunction(()=>fetchLog.filter(request=>request.url==='/luci-static/freeisp/release.json'&&request.decoded).length===2);
  await page.evaluate(()=>{freeispNavigation.navigate('/cgi-bin/luci/admin/network/routes');});
  await page.waitForFunction(previous=>fixture.documentId!==previous||fixture.loads['network/routes']===1,raceDocument);
  holdPermission=false;for(const response of heldResponses)response.end(html('system/package-manager'));
  if(await page.evaluate(()=>fixture.documentId)===raceDocument)issues.push('Detected release change is forgotten when a newer navigation arrives during the 30-second TTL.');else checks.release_change_survives_cancelled_navigation=true;
  await navigate('system/system');await page.waitForSelector('#login');
  assert(requests.some(r=>r.path==='/cgi-bin/luci/admin/system/system'&&r.dest==='document'));
  checks.expired_session_falls_back_to_login=true;
  await page.goto(base+'/cgi-bin/luci/admin/freeisp');await ready();
  await navigate('system/freeisp_files');
  try{await page.waitForSelector('#login',{timeout:1500});checks.malformed_permission_environment_falls_back=true;}catch(_){issues.push('Missing nodespec in router environment shows local error instead of full-page fallback.');}
  assert.deepEqual(errors,[]);checks.no_browser_errors=true;
  assert(requests.every(r=>r.method==='GET'));checks.no_http_mutations=true;
  const result={passed:issues.length===0,checks,issues};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(issues.length)process.exitCode=1;
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
