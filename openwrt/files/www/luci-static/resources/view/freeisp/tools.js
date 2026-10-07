'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var getStatus=rpc.declare({object:'freeisp.tools',method:'status',expect:{}});
var runTool=rpc.declare({object:'freeisp.tools',method:'run',params:['tool','host','port','interface','mac','reverse','rate','modem','phone','message','to','subject'],expect:{}});
var saveSettings=rpc.declare({object:'freeisp.tools',method:'save',params:['section','enabled','address','port','host','interval','from','username','password','clear_password'],expect:{}});
var fields={
 btest:[['enabled','Server enabled','select',['0','1']],['address','Bind IPv4 address'],['port','Listen port']],
 bandwidth:[['host','iperf3 server'],['port','Port','number'],['reverse','Direction','select',['0','1']]],
 email:[['host','SMTP relay'],['port','SMTP port (STARTTLS)','number'],['from','Sender address'],['username','SMTP username'],['password','New SMTP password (blank keeps saved)','password'],['clear_password','Clear saved password','select',['0','1']],['to','Recipient'],['subject','Subject'],['message','Message','textarea']],
 flood:[['host','Destination']], graph:[],scan:[['host','IPv4 subnet (/28 to /32)']],mac:[],
 netwatch:[['enabled','Monitor enabled','select',['0','1']],['host','Destination'],['interval','Probe interval (10–3600 seconds)','number']],
 sniffer:[['interface','Device','device'],['host','Host filter (optional)']], ping:[['host','Destination']],speed:[['host','Destination']],profile:[],romon:[],
 sms:[['modem','ModemManager modem number','number'],['phone','Recipient phone number'],['message','Text (up to 160 characters)','textarea']],
 telnet:[['host','Destination'],['port','TCP port','number']],torch:[['interface','Device','device'],['host','Host filter (optional)']],traceroute:[['host','Destination']],
 generator:[['host','iperf3 server'],['port','Port','number'],['rate','Rate (1–10 Mbit/s)','number']],monitor:[],wol:[['interface','Device','device'],['mac','MAC address']]
};
function values(inputs) { var out={}; Object.keys(inputs).forEach(k=>out[k]=inputs[k].value); return out; }
function counters(text) { var out={}; (text||'').split('\n').forEach(line=>{var m=line.match(/^\s*([^:]+):\s*(.*)$/);if(m){var n=m[2].trim().split(/\s+/).map(Number);if(n.length>=16&&n.every(Number.isFinite))out[m[1]]={rx:n[0],tx:n[8]};}});return out; }
return view.extend({
 load:function(){return getStatus();},
 render:function(initial){
  var current=null, inputs={}, previous=null, samples=[], busy=false, readOnly=!L.hasViewPermission();
  var heading=E('h3'),description=E('p'),form=E('div',{'class':'fi-tool-fields'}),output=E('pre',{'class':'fi-tool-output','aria-live':'polite'},'Select a tool.'),runtime=E('pre'),stamp=E('p'),graph=E('div'),list=E('div',{'class':'fi-tool-list'});
  var run=E('button',{'class':'cbi-button cbi-button-action',click:()=>act(false)},'Run');
  var save=E('button',{'class':'cbi-button cbi-button-save',click:()=>act(true)},'Save settings');
  function availability(){var tool=initial.tools.find(t=>t.id===current);run.disabled=readOnly||busy||!tool||!tool.available||['mac','romon','btest'].includes(current);save.disabled=readOnly||busy||!tool||!tool.available;}
  function showStatus(s){
   if(!s.ok)throw new Error(s.output||'Router returned an invalid status.');
   initial=s;stamp.textContent='Router status checked: '+new Date(s.timestamp*1000).toLocaleString();
   list.querySelectorAll('button').forEach(b=>{var t=s.tools.find(v=>v.id===b.dataset.tool);if(t)b.querySelector('small').textContent=t.available?'Available':t.reason?'Unavailable':t.dependency?'Missing package':'Not supported';});
   if(current==='btest') {
    var service=s.services&&s.services['freeisp-tools'],instance=service&&service.instances&&service.instances.bandwidth;
    runtime.textContent='Saved: '+(s.settings.btest.enabled==='1'?'enabled':'disabled')+' · Process: '+(!s.services_available?'status unavailable':instance&&instance.running?'running':'stopped');
   } else if(current==='netwatch'){
    var w=s.watch,enabled=s.settings.netwatch.enabled==='1',fresh=w&&w.host===s.settings.netwatch.host&&s.timestamp-w.checked_at<=Number(s.settings.netwatch.interval)*2+10;
    runtime.textContent=!enabled?'Netwatch disabled':!fresh?'No current probe result (waiting or service stopped)':(w.up?'UP':'DOWN')+' · '+w.host+' · '+new Date(w.checked_at*1000).toLocaleString();
   } else runtime.textContent='';
   availability();
  }
  function plot(result){
   var now=counters(result.output),elapsed=previous?result.timestamp-previous.time:0,rows=[];
   if(previous&&elapsed>0)Object.keys(now).forEach(name=>{var old=previous.data[name],n=now[name];if(old&&n.rx>=old.rx&&n.tx>=old.tx)rows.push({name:name,rx:(n.rx-old.rx)*8/elapsed/1000000,tx:(n.tx-old.tx)*8/elapsed/1000000});});
   previous={time:result.timestamp,data:now};
   output.textContent=rows.length?rows.map(r=>r.name+'  RX '+r.rx.toFixed(3)+' Mbit/s  TX '+r.tx.toFixed(3)+' Mbit/s').join('\n'):'First sample collected. Run again or wait for the next sample to calculate rates.';
   if(current==='graph'&&rows.length){samples.push(rows.reduce((sum,r)=>sum+r.rx+r.tx,0));samples=samples.slice(-30);var max=Math.max.apply(null,samples.concat([0.001]));graph.replaceChildren(E('p',{},'Aggregate RX + TX across all devices (bridges can count traffic twice). Scale: '+max.toFixed(3)+' Mbit/s'),E('div',{'class':'fi-tool-bars'},samples.map(n=>E('span',{title:n.toFixed(3)+' Mbit/s',style:'height:'+Math.max(1,n/max*100)+'%'}))));}
  }
  async function act(saving){
   if(readOnly||busy||!current)return;
   busy=true;availability();output.textContent=saving?'Saving settings…':'Running on router…';
   try {
    var v=values(inputs), result=saving?await saveSettings(current,v.enabled||'',v.address||'',v.port||'',v.host||'',v.interval||'',v.from||'',v.username||'',v.password||'',v.clear_password||''):await runTool(current,v.host||'',v.port||'',v.interface||'',v.mac||'',v.reverse||'',v.rate||'',v.modem||'',v.phone||'',v.message||'',v.to||'',v.subject||'');
    if(!result.ok)throw new Error((result.limited?'Time limit reached. ':'')+(result.output||'Action failed (code '+result.code+').'));
    if(['graph','monitor'].includes(current)&&!saving)plot(result);else output.textContent=result.output||'Action completed.';
    if(inputs.password)inputs.password.value='';
    showStatus(await getStatus());
   }catch(e){output.textContent='Failed: '+e.message;stamp.textContent='Status unavailable after failure; reconnect or retry.';runtime.textContent='Live status unavailable';previous=null;}finally{busy=false;availability();}
  }
  function select(tool){
   if(busy)return;current=tool.id;previous=null;samples=[];graph.replaceChildren();inputs={};heading.textContent=tool.name;description.textContent=tool.description;
   var defaults={host:'',port:tool.id==='telnet'?'23':'5201',rate:'1',modem:'0'},stored=initial.settings[tool.id]||{};
   form.replaceChildren.apply(form,(fields[tool.id]||[]).map(field=>{
    var key=field[0],kind=field[2]||'text',value=stored[key]===undefined?(defaults[key]||''):stored[key],input;
    if(kind==='select'||kind==='device'){var choices=kind==='device'?initial.interfaces:field[3];input=E('select',{},choices.map(choice=>E('option',{value:choice},key==='reverse'?(choice==='1'?'Download':'Upload'):key==='enabled'||key==='clear_password'?(choice==='1'?'Yes':'No'):choice)));}
    else input=E(kind==='textarea'?'textarea':'input',{type:kind,autocomplete:'off'});
    input.value=value||(kind==='device'?(initial.interfaces.find(i=>i!=='lo')||'lo'):'');inputs[key]=input;
    return E('label',{},[E('span',{},field[1]),input]);
   }));
   save.style.display=['btest','netwatch','email'].includes(tool.id)?'':'none';
   run.textContent=['graph','monitor'].includes(tool.id)?'Sample now':tool.id==='email'?'Send email':tool.id==='sms'?'Send SMS':'Run';
   output.textContent=tool.available?(tool.id==='email'?'Save relay settings before sending. Saved password: '+(stored.password_saved?'yes':'no'):'Ready. Actions run on the connected router.'):(tool.reason|| (tool.dependency?'Unavailable: install '+tool.dependency+' and coreutils-timeout on the router.':tool.description));
   list.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.tool===current));showStatus(initial);
  }
  initial.tools.forEach(t=>list.appendChild(E('button',{'data-tool':t.id,click:()=>select(initial.tools.find(v=>v.id===t.id))},[t.name,E('small',{},t.available?'Available':t.reason?'Unavailable':t.dependency?'Missing package':'Not supported')])));
  poll.add(async function(){if(busy)return;try{if(['graph','monitor'].includes(current))await act(false);else showStatus(await getStatus());}catch(e){stamp.textContent='Router unreachable. Displayed results are stale.';runtime.textContent='Live status unavailable';}},5);
  var page=E('div',{'class':'fi-tools'},[E('style',{},'.fi-tool-layout{display:grid;grid-template-columns:210px 1fr;gap:20px}.fi-tool-list button{display:block;width:100%;text-align:left;margin:0 0 4px;padding:8px}.fi-tool-list small{display:block;opacity:.7}.fi-tool-list .active{border-left:4px solid #13a5a0}.fi-tool-fields label{display:grid;grid-template-columns:240px 1fr;gap:12px;margin:10px 0}.fi-tool-output{white-space:pre-wrap;max-height:440px;overflow:auto;min-height:100px}.fi-tool-bars{display:flex;align-items:end;gap:3px;height:130px}.fi-tool-bars span{background:#13a5a0;flex:1}.fi-tool-actions{display:flex;gap:8px}@media(max-width:800px){.fi-tool-layout{grid-template-columns:1fr}.fi-tool-fields label{grid-template-columns:1fr}}'),E('h2',{},'Tools'),E('p',{},'Router diagnostics and services. Results are measured on the connected OpenWrt router. Tests generate traffic; use destinations you administer.'),stamp,E('div',{'class':'fi-tool-layout'},[list,E('section',{},[heading,description,form,E('div',{'class':'fi-tool-actions'},[run,save]),runtime,graph,output])])]);
  select(initial.tools.find(t=>t.id==='ping')||initial.tools[0]);return page;
 },handleSaveApply:null,handleSave:null,handleReset:null
});
