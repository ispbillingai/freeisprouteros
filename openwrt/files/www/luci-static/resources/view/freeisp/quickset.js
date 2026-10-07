'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require freeisp.quickset-data as data';

var interfaces = rpc.declare({object:'network.interface', method:'dump', expect:{interface:[]}});
var devices = rpc.declare({object:'network.device', method:'status', expect:{'':{}}});
var configs = ['network','dhcp','firewall','system'];

return view.extend({
    load:function() { return Promise.all([Promise.all(configs.map(function(c) { return uci.load(c); })), interfaces(), devices()]); },
    render:function(result) {
        var self=this, fields={}, original={}, states=result[1], devs=result[2];
        var wan=states.filter(function(s) { return s.interface==='wan'; })[0] || {};
        var current=(wan['ipv4-address'] || [])[0] || {};
        var route=(wan.route || []).filter(function(r) { return r.target==='0.0.0.0'; })[0] || {};
        var zone=uci.sections('firewall','zone').filter(function(s) { return s.name==='wan'; })[0];
        var system=uci.sections('system','system')[0];
        var lanIP=uci.get('network','lan','ipaddr') || '', lanMask=uci.get('network','lan','netmask') || '255.255.255.0';
        var range='';
        try { var subnet=data.subnet(lanIP,lanMask), start=Number(uci.get('dhcp','lan','start') || 100), count=Number(uci.get('dhcp','lan','limit') || 150); range=data.address(subnet.start+start)+'-'+data.address(subnet.start+start+count-1); } catch(e) {}
        function input(key,value,type,disabled) {
            var node=E('input',{id:'qs-'+key,type:type || 'text',disabled:disabled || null});
            if (type==='checkbox') node.checked=!!value; else node.value=value == null ? '' : value;
            fields[key]=node; original[key]=type==='checkbox' ? node.checked : node.value; return node;
        }
        function row(label,node) { return E('div',{'class':'qs-row'},[E('label',{'for':node.id || null},label),node]); }
        function check(key,label,value,disabled) { return E('label',{'class':'qs-check'},[input(key,value,'checkbox',disabled),' '+label]); }
        function section(title,children) { return E('fieldset',{},[E('legend',{},title)].concat(children)); }
        function link(label,path) { return E('a',{'class':'qs-button',href:L.url.apply(L,['admin'].concat(path))},label); }
        function unavailable(label,value) { return row(label,input('unavailable-'+Object.keys(fields).length,value || 'Unavailable', 'text',true)); }
        function radios(name,items,selected,disabled) { return E('span',{'class':'qs-radios'},items.map(function(item) { return E('label',{},[E('input',{type:'radio',name:name,value:item[0],checked:selected===item[0] || null,disabled:disabled || null,change:function(){self.updateProtocol();}}),' '+item[1]]); })); }
        var proto=uci.get('network','wan','proto') || 'dhcp';
        var root=E('div',{'class':'qs-window'},[
            E('link',{rel:'stylesheet',href:L.resource('freeisp/quickset.css')}),
            E('div',{'class':'qs-title'},[E('select',{'aria-label':'Quick Set profile',disabled:true},[E('option',{},'Router')]),E('span',{},'Quick Set'),E('span',{'class':'qs-brand'},'FreeISP')]),
            E('div',{'class':'qs-content'},[
                E('div',{'class':'qs-left'},[
                    section('Wireless',[
                        row('Wireless Protocol:',radios('qs-wireless',[['80211','802.11'],['nstreme','nstreme'],['nv2','nv2']],'80211',true)),
                        unavailable('Network Name:','No wireless radio'), unavailable('Frequency:'), unavailable('Band:'), unavailable('Channel Width:'), unavailable('Country:'), unavailable('MAC Address:'),
                        check('acl','Use Access List (ACL)',false,true),
                        E('div',{'class':'qs-security'},[E('span',{},'Security: '),check('wpa','WPA',false,true),check('wpa2','WPA2',false,true)]),
                        E('p',{'class':'qs-hint'},'This router has no wireless radio. Wireless setup is unavailable.')
                    ]),
                    section('Wireless Clients',[
                        E('div',{'class':'qs-client-list'},[E('table',{},[E('thead',{},E('tr',{},['MAC Address','In ACL','Last IP','Uptime','Signal Strength'].map(function(t){return E('th',{},t);}))),E('tbody',{},E('tr',{},E('td',{colspan:5,'class':'qs-empty'},'No wireless radio')))])]),
                        E('div',{'class':'qs-signal'},E('span',{},'■ Signal Strength: —')),
                        E('div',{'class':'qs-end'},[E('button',{disabled:true},'Copy To ACL'),E('button',{disabled:true},'Remove From ACL')])
                    ])
                ]),
                E('div',{'class':'qs-right'},[
                    section('Configuration',[row('Mode:',radios('qs-mode',[['router','Router'],['bridge','Bridge']],'router',true)),E('p',{'class':'qs-hint'},['Bridge configuration: ',link('Interfaces',['network','network'])])]),
                    section('Internet',[
                        row('Address Acquisition:',radios('qs-proto',[['static','Static'],['dhcp','Automatic'],['pppoe','PPPoE']],proto,false)),
                        row('IP Address:',input('wanIP',uci.get('network','wan','ipaddr') || current.address || '')),
                        row('Netmask:',input('wanMask',uci.get('network','wan','netmask') || (current.mask ? data.address((4294967295 << (32-current.mask)) >>> 0) : '255.255.255.0'))),
                        row('Gateway:',input('gateway',uci.get('network','wan','gateway') || route.nexthop || '')),
                        row('DNS Servers:',input('dns',[].concat(uci.get('network','wan','dns') || []).join(' '))),
                        row('PPPoE User:',input('pppUser',uci.get('network','wan','username') || '')),
                        row('PPPoE Password:',input('pppPassword','','password')),
                        E('p',{'class':'qs-hint','id':'qs-password-hint'},'Leave the password empty to keep the existing password.'),
                        unavailable('MAC Address:',(devs[wan.l3_device] || devs[wan.device] || {}).macaddr || 'Unavailable'),
                        check('firewall','Firewall Router',true,true),
                        E('div',{'class':'qs-end'},[link('Renew / Release',['network','network'])])
                    ]),
                    section('Local Network',[
                        row('IP Address:',input('lanIP',lanIP)), row('Netmask:',input('lanMask',lanMask)),
                        check('dhcp','DHCP Server',uci.get('dhcp','lan','ignore')!=='1'),
                        row('DHCP Server Range:',input('range',range)), check('nat','NAT',!!zone && zone.masq==='1',!zone),
                        E('div',{'class':'qs-end'},link('Port Mapping',['network','firewall','forwards']))
                    ]),
                    section('VPN',[check('vpn','VPN Access',false,true),E('p',{'class':'qs-hint'},['Configure a tunnel in ',link('Interfaces',['network','network'])])]),
                    section('System',[
                        row('Router Identity:',input('hostname',system ? system.hostname : 'FreeISP')),
                        E('div',{'class':'qs-end'},[link('Check For Updates',['system','package-manager']),link('Reset Configuration',['system','flash'])]),
                        E('div',{'class':'qs-end'},link('Password…',['system','admin']))
                    ])
                ]),
                E('div',{'class':'qs-actions'},[
                    E('button',{click:function(){self.save(true);}},'OK'),
                    E('button',{click:function(){window.location.reload();}},'Cancel'),
                    E('button',{click:function(){self.save(false);}},'Apply')
                ])
            ]),
            E('div',{'class':'qs-status',role:'status'},wan.up ? 'active · Internet connected' : 'Internet disconnected')
        ]);
        self.updateProtocol=function() {
            var selected=root.querySelector('input[name="qs-proto"]:checked');
            var p=selected ? selected.value : proto;
            ['wanIP','wanMask','gateway','dns'].forEach(function(k){fields[k].disabled=p!=='static';});
            ['pppUser','pppPassword'].forEach(function(k){fields[k].closest('.qs-row').hidden=p!=='pppoe';});
            root.querySelector('#qs-password-hint').hidden=p!=='pppoe';
        };
        self.updateProtocol();
        self.save=async function(close) {
            var buttons=root.querySelectorAll('.qs-actions button');
            try {
                var existing=await uci.changes();
                if (Object.keys(existing).some(function(c){return existing[c].length;})) throw new Error('There are pending changes from another page. Apply or revert those changes before using Quick Set.');
                var pnode=root.querySelector('input[name="qs-proto"]:checked');
                if (!pnode) throw new Error('This WAN protocol requires the Interfaces page.');
                var p=pnode.value, changes=[];
                function value(k){return fields[k].type==='checkbox' ? fields[k].checked : fields[k].value.trim();}
                function changed(k){return value(k)!==original[k];}
                function set(c,s,k,v){changes.push([c,s,k,v]);}
                if (!uci.get('network','lan') || uci.get('network','lan','proto')!=='static' || !uci.get('network','wan') || !system) throw new Error('This interface layout needs the advanced Interfaces page.');
                if (changed('hostname')) {
                    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value('hostname'))) throw new Error('Router Identity must contain 1–63 letters, numbers or hyphens, and start and end with a letter or number.');
                    set('system',system['.name'],'hostname',value('hostname'));
                }
                if (p!==proto) set('network','wan','proto',p);
                if (p==='static' && (p!==proto || ['wanIP','wanMask','gateway','dns'].some(changed))) {
                    var ws=data.subnet(value('wanIP'),value('wanMask')), gw=data.ip(value('gateway'));
                    if (gw<=ws.start || gw>=ws.end || gw===ws.host) throw new Error('The gateway must be another host in the WAN subnet.');
                    var dns=value('dns').split(/[\s,]+/).filter(Boolean); dns.forEach(data.ip);
                    if (!dns.length) throw new Error('Enter at least one DNS server for a static Internet connection.');
                    set('network','wan','ipaddr',value('wanIP')); set('network','wan','netmask',value('wanMask')); set('network','wan','gateway',value('gateway')); set('network','wan','dns',dns);
                }
                if (p==='pppoe' && (p!==proto || changed('pppUser') || changed('pppPassword'))) {
                    if (!value('pppUser')) throw new Error('Enter your PPPoE username.');
                    if (!fields.pppPassword.value && !uci.get('network','wan','password')) throw new Error('Enter your PPPoE password.');
                    set('network','wan','username',value('pppUser'));
                    if (fields.pppPassword.value) set('network','wan','password',fields.pppPassword.value);
                }
                if (['lanIP','lanMask','range','dhcp'].some(changed)) {
                    var ls=data.subnet(value('lanIP'),value('lanMask'));
                    states.filter(function(s){return s.interface!=='lan';}).forEach(function(s){(s['ipv4-address'] || []).forEach(function(a){
                        var mask=(4294967295 << (32-a.mask)) >>> 0, begin=(data.ip(a.address)&mask)>>>0, end=begin+4294967295-mask;
                        if (ls.start<=end && ls.end>=begin) throw new Error('The local subnet overlaps '+s.interface+'.');
                    });});
                    if (p==='static') {var sw=data.subnet(value('wanIP'),value('wanMask')); if(ls.start<=sw.end && ls.end>=sw.start) throw new Error('WAN and local subnets must not overlap.');}
                    if (value('dhcp')) {var pool=data.pool(value('range'),ls);set('dhcp','lan','start',String(pool.start));set('dhcp','lan','limit',String(pool.limit));}
                    if (!uci.get('dhcp','lan')) throw new Error('Create a LAN DHCP section in the DHCP page first.');
                    set('dhcp','lan','ignore',value('dhcp')?'0':'1');set('network','lan','ipaddr',value('lanIP'));set('network','lan','netmask',value('lanMask'));
                }
                if (p==='static' && changes.some(function(c){return c[0]==='network';})) {var a=data.subnet(value('lanIP'),value('lanMask')), b=data.subnet(value('wanIP'),value('wanMask')); if(a.start<=b.end && a.end>=b.start) throw new Error('WAN and local subnets must not overlap.');}
                if (zone && changed('nat')) set('firewall',zone['.name'],'masq',value('nat')?'1':'0');
                if (!changes.length) {root.querySelector('.qs-status').textContent='No changes to apply';if(close) window.location=L.url('admin','status','overview');return;}
                buttons.forEach(function(b){b.disabled=true;});
                changes.forEach(function(c){uci.set.apply(uci,c);});
                await uci.save(); await ui.changes.init();
                document.addEventListener('uci-applied',function(){window.location=close ? L.url('admin','status','overview') : L.url('admin','freeisp');},{once:true});
                ui.changes.apply(true);
            } catch(e) {ui.addNotification(null,E('p',{},e.message),'error');}
            finally {buttons.forEach(function(b){b.disabled=false;});}
        };
        return root;
    },
    handleSaveApply:null,handleSave:null,handleReset:null
});
