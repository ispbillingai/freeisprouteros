'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require freeisp.hotspot-data as data';

var snapshot = rpc.declare({object:'freeisp.hotspot',method:'snapshot',expect:{'':{}}});
var mutate = rpc.declare({object:'freeisp.hotspot',method:'mutate',params:['action','payload'],expect:{'':{}}});
function checked(response) { if (!response || response.ok===false || response.error) {var error=new Error(response && response.error && response.error.message || 'The router could not complete this request.');error.code=response && response.error && response.error.code;throw error;} return response; }

return view.extend({
    load:function() { return snapshot().then(checked).catch(function(error){return {revision:null,collections:{},runtime:{available:false,error:error.message},loadError:error.message};}); },
    render:function(initial) {
        var self=this, state=initial, current='servers', selected={}, search='', busy=false, refreshing=false, dialogOpen=false, generation=0, root;
        var canWrite=typeof L.hasViewPermission==='function' && L.hasViewPermission();
        function canEdit() { return canWrite && state.can_write!==false; }
        function schema() { return data.schemas.filter(function(s){return s.key===current;})[0]; }
        function rows() { return (state.collections && state.collections[current]) || []; }
        function chosen() { return rows().filter(function(row){return selected[row.id];}); }
        function nameFor(collection,id) { if(id==='all')return 'All servers';var match=(state.collections && state.collections[collection] || []).filter(function(r){return r.id===id;})[0];return match ? match.name : id || '—'; }
        function labelValue(row,key) {
            var value=row[key];
            if(key==='profile')return nameFor(current==='servers'?'server_profiles':'user_profiles',value);
            if(key==='server')return nameFor('servers',value);
            if(key==='authorized'||key==='cookie_login')return value===true || value===1 || value==='1' ? 'Yes' : 'No';
            if(['uptime','session_timeout','idle_timeout','limit_uptime'].indexOf(key)>=0)return +value===0 && key!=='uptime' ? 'Unlimited' : data.duration(value);
            if(key==='bytes_in'||key==='bytes_out')return data.bytes(value);
            if(key==='rate_limit_up'||key==='rate_limit_down')return +value===0?'Unlimited':data.bytes(value)+'/s';
            if(key==='expires_at' && value) {var date=new Date(typeof value==='number'?value*1000:value);return isNaN(date.getTime())?String(value):date.toLocaleString();}
            return value===undefined || value===null || value==='' ? '—' : String(value);
        }
        function message(text,kind) {var node=root.querySelector('.hs-notice');node.textContent=text || '';node.className='hs-notice'+(kind?' hs-'+kind:'');node.hidden=!text;node.setAttribute('role',kind==='error'?'alert':'status');}
        function button(text,action,attrs) {return E('button',Object.assign({type:'button',click:action},attrs || {}),text);}
        function writable() {return canEdit() && state.revision!=null && !busy;}
        function updateToolbar() {
            var count=chosen().length,s=schema(),can=writable(),runtime=!!(state.runtime && state.runtime.available);
            root.querySelectorAll('[data-action]').forEach(function(b){var a=b.dataset.action;b.hidden=(['add','edit','enable','disable','remove'].indexOf(a)>=0 && !!s.live) || (a==='disconnect'&&current!=='active') || (a==='remove_cookies'&&current!=='cookies') || (['setup','reset_html'].indexOf(a)>=0&&current!=='servers');b.disabled=!can || (['edit','reset_html'].indexOf(a)>=0&&count!==1) || (['enable','disable','remove','disconnect','remove_cookies'].indexOf(a)>=0&&!count) || (['disconnect','remove_cookies'].indexOf(a)>=0&&!runtime);});
            root.querySelector('[data-action="refresh"]').disabled=busy||refreshing;
            root.querySelector('.hs-selection').textContent=count?count+' selected':'';
        }
        function showTable() {
            var s=schema(),all=rows(),needle=search.toLowerCase(),visible=all.filter(function(row){return !needle || s.columns.concat(['comment']).some(function(key){return labelValue(row,key).toLowerCase().indexOf(needle)>=0;});});
            Object.keys(selected).forEach(function(id){if(!all.some(function(r){return r.id===id;}))delete selected[id];});
            var table=E('table',{'class':'hs-table','aria-label':s.label}),head=E('tr'),selectAll=E('input',{type:'checkbox','aria-label':'Select all visible '+s.label.toLowerCase(),change:function(){visible.forEach(function(r){if(selectAll.checked)selected[r.id]=true;else delete selected[r.id];});showTable();}});
            selectAll.checked=visible.length>0&&visible.every(function(r){return selected[r.id];});selectAll.indeterminate=visible.some(function(r){return selected[r.id];})&&!selectAll.checked;selectAll.disabled=!visible.length;
            head.appendChild(E('th',{'class':'hs-select'},selectAll));if(!s.live)head.appendChild(E('th',{},'Status'));
            s.columns.forEach(function(key){head.appendChild(E('th',{scope:'col'},data.labels[key]||key));});
            table.appendChild(E('thead',{},head));var body=E('tbody');
            visible.forEach(function(row) {
                var title=row.name||row.user||row.address||row.host||row.dst_address||row.mac_address||row.id;
                var checkbox=E('input',{type:'checkbox','aria-label':'Select '+title,change:function(){if(checkbox.checked)selected[row.id]=true;else delete selected[row.id];tr.classList.toggle('is-selected',!!selected[row.id]);updateToolbar();var allSelected=visible.every(function(r){return selected[r.id];});selectAll.checked=allSelected;selectAll.indeterminate=!allSelected&&visible.some(function(r){return selected[r.id];});}});checkbox.checked=!!selected[row.id];
                var tr=E('tr',{'class':(selected[row.id]?'is-selected ':'')+(row.disabled?'is-disabled':''),dblclick:function(event){if(!s.live && writable() && event.target.tagName!=='INPUT')openEditor(s,row);}},[E('td',{},checkbox)]);
                if(!s.live)tr.appendChild(E('td',{},E('span',{'class':'hs-badge'+(row.disabled?' is-off':'')},row.disabled?'Disabled':'Enabled')));
                s.columns.forEach(function(key,index){var text=labelValue(row,key);tr.appendChild(E('td',{title:text},index===0&&!s.live?button(text,function(){openEditor(s,row);},{'class':'hs-row-link','aria-label':(canEdit()?'Edit ':'View ')+s.singular.toLowerCase()+' '+title}):text));});
                body.appendChild(tr);
            });
            if(!visible.length)body.appendChild(E('tr',{},E('td',{colspan:s.columns.length+(s.live?1:2),'class':'hs-empty'},search?'No matching '+s.label.toLowerCase()+'.':s.live?(state.runtime && state.runtime.available?'No '+s.label.toLowerCase()+' right now.':'Live Hotspot information is unavailable.'): 'No '+s.label.toLowerCase()+' yet. Use Add to create one.')));
            table.appendChild(body);var wrap=root.querySelector('.hs-table-wrap');wrap.replaceChildren(table);
            root.querySelector('.hs-count').textContent=visible.length+' of '+all.length+' '+s.label.toLowerCase();
            root.querySelector('.hs-tab-description').textContent=({servers:'Manage captive portal servers and their network interfaces.',server_profiles:'Choose the sign-in address, login port and remembered sign-in settings.',users:'Manage local sign-in accounts, quotas and server access.',user_profiles:'Set concurrent sessions, timeouts and speed limits.',active:'Connected users and their current session usage.',hosts:'Devices discovered on the Hotspot network.',ip_bindings:'Require sign-in, bypass it or block specific addresses.',service_ports:'Allow signed-in users to access specific services on the router.',walled_garden:'Allow or deny exact host names before sign-in. Rules use resolved IPv4 addresses, which can be shared by other sites.',walled_garden_ip:'Allow or deny destination addresses before sign-in.',cookies:'Remembered sign-ins stored by the Hotspot.'})[current];
            updateToolbar();
        }
        function displayStatus() {
            var runtime=state.runtime || {},status=root.querySelector('.hs-runtime');status.textContent=runtime.available?'Hotspot service available':'Hotspot service unavailable';status.classList.toggle('is-up',!!runtime.available);
            var warning=root.querySelector('.hs-runtime-warning');warning.textContent=runtime.available?'':runtime.error || 'Live sessions are unavailable. Saved settings can still be managed.';warning.hidden=!!runtime.available;
            var readOnly=root.querySelector('.hs-readonly');readOnly.hidden=canEdit();
        }
        function refresh(manual) {
            if(refreshing||busy)return Promise.resolve();refreshing=true;var request=++generation;updateToolbar();
            return snapshot().then(checked).then(function(result){if(request!==generation)return;state=result;displayStatus();showTable();root.querySelector('.hs-updated').textContent='Updated '+new Date().toLocaleTimeString();if(manual)message('Hotspot information refreshed.','success');}).catch(function(error){message('Could not refresh: '+error.message,'error');}).finally(function(){refreshing=false;updateToolbar();});
        }
        function perform(action,payload,success) {
            if(!writable())return Promise.reject(new Error('You do not have permission to change Hotspot settings.'));
            busy=true;generation++;updateToolbar();payload.revision=state.revision;
            return mutate(action,JSON.stringify(payload)).then(checked).then(function(result){if(result.revision)state.revision=result.revision;busy=false;return snapshot().then(checked).then(function(fresh){state=fresh;displayStatus();showTable();message(success || 'Changes saved.','success');}).catch(function(error){message((success || 'Changes saved.')+' Could not refresh: '+error.message,'error');});}).catch(function(error){message(error.message,'error');throw error;}).finally(function(){busy=false;updateToolbar();});
        }
        function modal(title,content,actions) {dialogOpen=true;ui.showModal(title,[E('div',{'class':'hs-modal'},content),E('div',{'class':'hs-modal-actions'},actions)]);}
        function closeModal() {dialogOpen=false;ui.hideModal();}
        function formFields(s,record) {
            var fields={},errors={},nodes=[];
            s.fields.forEach(function(f){
                var id='hs-field-'+f.key,attributes={id:id,name:f.key,'aria-describedby':id+'-error'},node,value=record&&f.type!=='password'?record[f.key]:f.value;
                if(f.type==='select'||f.type==='reference'||f.type==='interface'){
                    var options=f.options || [];
                    if(f.type==='reference')options=(f.all?[['all','All servers']]:[['','Select a '+(f.collection==='user_profiles'?'user profile':'server profile')]]) .concat((state.collections[f.collection]||[]).map(function(r){return [r.id,r.name+(r.disabled?' (disabled)':'')];}));
                    if(f.type==='interface')options=[['','Select an interface']].concat((state.interfaces||[]).map(function(i){var name=typeof i==='string'?i:i.name;return [name,name+(i.eligible===false?' — '+(i.reason||'Unavailable'):''),i.eligible===false];}));
                    if(value && !options.some(function(o){return (Array.isArray(o)?o[0]:o)===value;}))options.push([value,value+' (unavailable)']);
                    node=E('select',attributes,options.map(function(o){return E('option',{value:Array.isArray(o)?o[0]:o,disabled:Array.isArray(o)&&o[2]||null},Array.isArray(o)?o[1]:o);}));
                    if(value!=null)node.value=value;
                } else {
                    attributes.type=['checkbox','password','number'].indexOf(f.type)>=0?f.type:'text';if(f.placeholder)attributes.placeholder=f.placeholder;if(f.max&&f.type!=='number')attributes.maxlength=f.max;if(f.type==='number'){attributes.min=f.min||0;attributes.step=1;if(f.max)attributes.max=f.max;}if(f.type==='password')attributes.autocomplete='new-password';
                    node=E('input',attributes);if(f.type==='checkbox')node.checked=!!value;else node.value=value==null?'':value;
                }
                if(f.required)node.setAttribute('aria-required','true');if(!writable())node.disabled=true;fields[f.key]=node;
                var error=E('span',{id:id+'-error','class':'hs-field-error'});errors[f.key]=error;
                var children=[E('label',{'for':id},f.label+(f.required?' *':'')),node,error];
                if(f.type==='password'&&record)children.push(E('small',{},'Leave empty to keep the existing password.'));
                if(f.key==='address_pool')children.push(E('small',{},'Use a subnet already configured on this interface. This does not change DHCP.'));
                if(f.type==='interface')children.push(E('small',{},'Use a dedicated customer interface. Unavailable interfaces show the reason in the list.'));
                if(f.key==='http_port')children.push(E('small',{},'Enabled servers must use the same login port.'));
                if(f.key==='dns_name')children.push(E('small',{},'Optional existing DNS alias. Configure its DNS record separately.'));
                if(s.key==='ip_bindings'&&f.key==='address')children.push(E('small',{},'Specify an address, a MAC address, or both.'));
                nodes.push(E('div',{'class':'hs-field'+(f.type==='checkbox'?' hs-checkbox':'')},children));
            });
            return {nodes:nodes,fields:fields,validate:function(){var values={};Object.keys(fields).forEach(function(key){var node=fields[key];values[key]=node.type==='checkbox'?node.checked:node.value;errors[key].textContent='';node.removeAttribute('aria-invalid');});var result=data.validate(s,values,!!record);Object.keys(result.errors).forEach(function(key){errors[key].textContent=result.errors[key];fields[key].setAttribute('aria-invalid','true');});var first=Object.keys(result.errors)[0];if(first)fields[first].focus();return result;}};
        }
        function openEditor(s,record) {
            var form=formFields(s,record),error=E('p',{'class':'hs-form-error',role:'alert'}),save=button('Save',async function(){var values=form.validate();if(Object.keys(values.errors).length)return;if(record)values.record.id=record.id;save.disabled=true;cancel.disabled=true;error.textContent='';try{await perform('save',{collection:s.key,record:values.record},s.singular+' saved.');closeModal();}catch(e){error.textContent=e.message;if(e.code==='conflict'||e.code==='stale_revision')error.textContent+=' Close this window and refresh before trying again.';}finally{save.disabled=!writable();cancel.disabled=false;}},{'class':'hs-primary',disabled:!writable()}),cancel=button(canEdit()?'Cancel':'Close',closeModal);
            modal((record?(canEdit()?'Edit ':'View '):'Add ')+s.singular.toLowerCase(),[error,E('div',{'class':'hs-form'},form.nodes)],[cancel].concat(canEdit()?[save]:[]));
        }
        function confirmAction(title,text,action,payload,success) {
            var error=E('p',{'class':'hs-form-error',role:'alert'}),cancel=button('Cancel',closeModal),apply=button(title,async function(){apply.disabled=true;cancel.disabled=true;try{await perform(action,payload,success);closeModal();}catch(e){error.textContent=e.message;}finally{apply.disabled=!writable();cancel.disabled=false;}},{'class':'hs-primary'});modal(title,[E('p',{},text),error],[cancel,apply]);
        }
        function batch(action) {var ids=chosen().map(function(r){return r.id;});if(!ids.length)return;if(action==='enable'||action==='disable'){perform('set_enabled',{collection:current,ids:ids,enabled:action==='enable'},ids.length+' item(s) '+(action==='enable'?'enabled.':'disabled.')).catch(function(){});return;}var title=action==='disconnect'?'Disconnect sessions':action==='remove_cookies'?'Remove cookies':'Remove items';confirmAction(title,action==='disconnect'?'Disconnect '+ids.length+' selected session(s)? Devices with remembered sign-ins may reconnect automatically.':action==='remove_cookies'?'Remove '+ids.length+' selected remembered sign-in(s)?':'Remove '+ids.length+' selected item(s)? This cannot be undone.',action==='remove'?'remove':action,{collection:current,ids:ids},title+' completed.');}
        function setup() {
            var setupSchema={key:'setup',fields:[{key:'name',label:'Server name',type:'text',required:true,max:120,value:'hotspot1'},{key:'interface',label:'Interface',type:'interface',required:true},{key:'local_address',label:'Local hotspot address',type:'ip',required:true,placeholder:'10.42.0.1'},{key:'address_pool',label:'Existing client subnet',type:'cidr',required:true,placeholder:'10.42.0.0/24'},{key:'dns_name',label:'Login DNS name (optional)',type:'hostname'},{key:'http_port',label:'Login port',type:'number',min:1024,max:65535,value:((state.collections.server_profiles||[]).filter(function(p){return !p.disabled;})[0]||{}).http_port||6480}]},form=formFields(setupSchema),error=E('p',{'class':'hs-form-error',role:'alert'}),preview=E('div',{'class':'hs-setup-preview'}),step=1,payload;
            var back=button('Back',function(){step=1;formNode.hidden=false;preview.hidden=true;back.hidden=true;next.textContent='Review setup';error.textContent='';}),cancel=button('Cancel',closeModal),next=button('Review setup',async function(){if(step===1){var result=form.validate();if(Object.keys(result.errors).length)return;payload=result.record;preview.replaceChildren(E('p',{},'Create '+payload.name+' on '+payload.interface+' with address pool '+payload.address_pool+' and sign-in address '+payload.local_address+' on port '+payload.http_port+'.'),E('p',{},'This creates a server, matching profiles and the default sign-in page. The selected interface must already use this local address and subnet.'));formNode.hidden=true;preview.hidden=false;back.hidden=false;next.textContent='Create Hotspot';step=2;return;}next.disabled=true;back.disabled=true;cancel.disabled=true;try{await perform('setup',payload,'Hotspot created. Add a user to enable local sign-in.');closeModal();}catch(e){error.textContent=e.message;}finally{next.disabled=!writable();back.disabled=false;cancel.disabled=false;}},{'class':'hs-primary'}),formNode=E('div',{'class':'hs-form'},form.nodes);back.hidden=true;preview.hidden=true;
            modal('Hotspot Setup',[E('p',{},'Choose a dedicated, configured interface for your captive portal.'),error,formNode,preview],[cancel,back,next]);
        }
        function switchTab(key,focus) {current=key;selected={};search='';root.querySelector('.hs-search').value='';root.querySelectorAll('[role="tab"]').forEach(function(tab){var active=tab.dataset.tab===key;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();});root.querySelector('[role="tabpanel"]').setAttribute('aria-labelledby','hs-tab-'+key);showTable();}
        root=E('div',{'class':'hs-window'},[
            E('link',{rel:'stylesheet',href:L.resource('freeisp/hotspot.css')+'?v=1'}),
            E('div',{'class':'hs-heading'},[E('div',{},[E('h2',{},'Hotspot'),E('p',{},'Sign-in access, accounts and connected devices.')]),E('span',{'class':'hs-runtime',role:'status'})]),
            E('p',{'class':'hs-readonly'},'Read-only access. You can inspect settings and live sessions.'),E('p',{'class':'hs-runtime-warning',role:'status'}),E('p',{'class':'hs-notice',hidden:true,role:'status'}),
            E('div',{'class':'hs-tabs',role:'tablist','aria-label':'Hotspot sections'},data.schemas.map(function(s,index){return button(s.label,function(){switchTab(s.key);},{id:'hs-tab-'+s.key,'data-tab':s.key,role:'tab','aria-selected':String(index===0),'aria-controls':'hs-panel',tabindex:index===0?0:-1,keydown:function(event){var i=data.schemas.indexOf(s),target;if(event.key==='ArrowRight')target=(i+1)%data.schemas.length;if(event.key==='ArrowLeft')target=(i+data.schemas.length-1)%data.schemas.length;if(event.key==='Home')target=0;if(event.key==='End')target=data.schemas.length-1;if(target!==undefined){event.preventDefault();switchTab(data.schemas[target].key,true);}}});})),
            E('div',{id:'hs-panel',role:'tabpanel','aria-labelledby':'hs-tab-servers'},[
                E('div',{'class':'hs-toolbar'},[
                    button('Add',function(){openEditor(schema());},{'data-action':'add','class':'hs-primary'}),button('Edit',function(){openEditor(schema(),chosen()[0]);},{'data-action':'edit'}),button('Enable',function(){batch('enable');},{'data-action':'enable'}),button('Disable',function(){batch('disable');},{'data-action':'disable'}),button('Remove',function(){batch('remove');},{'data-action':'remove'}),button('Disconnect',function(){batch('disconnect');},{'data-action':'disconnect'}),button('Remove cookies',function(){batch('remove_cookies');},{'data-action':'remove_cookies'}),button('Hotspot Setup',setup,{'data-action':'setup'}),button('Reset HTML',function(){var row=chosen()[0];if(row)confirmAction('Reset HTML','Replace the sign-in page for '+row.name+' with the default page? Existing page customizations will be removed.','reset_html',{server_id:row.id},'Default sign-in page restored.');},{'data-action':'reset_html'}),button('Refresh',function(){refresh(true);},{'data-action':'refresh'}),
                    E('label',{'class':'hs-filter'},[E('span',{},'Filter'),E('input',{type:'search','class':'hs-search','aria-label':'Filter Hotspot table',placeholder:'Search this tab',input:function(event){search=event.target.value;showTable();}})])
                ]),E('p',{'class':'hs-tab-description'}),E('div',{'class':'hs-table-wrap',tabindex:0,'aria-label':'Scrollable Hotspot table'}),E('div',{'class':'hs-footer'},[E('span',{'class':'hs-count'}),E('span',{'class':'hs-selection'}),E('span',{'class':'hs-updated'}),E('label',{'class':'hs-live'},[E('input',{type:'checkbox',checked:true,'aria-label':'Refresh live information every 10 seconds'}),' Live refresh'])])
            ])
        ]);
        displayStatus();showTable();if(initial.loadError)message('Could not load Hotspot settings: '+initial.loadError,'error');
        poll.add(function(){if(root.isConnected&&!dialogOpen&&root.querySelector('.hs-live input').checked&&!document.hidden)return refresh(false);return Promise.resolve();},10);
        self.refresh=refresh;return root;
    },handleSaveApply:null,handleSave:null,handleReset:null
});
