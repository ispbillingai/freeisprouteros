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
        function section(title,children) { var parts=title.split(' / '); return E('fieldset',{},[E('legend',{},[E('span',{},parts[0]+' /'),parts[1]])].concat(children)); }
        function link(label,path) { return E('a',{'class':'qs-button',href:L.url.apply(L,['admin'].concat(path))},label); }
        function unavailable(label,value) { return row(label,input('unavailable-'+Object.keys(fields).length,value || 'Unavailable', 'text',true)); }
        function radios(name,items,selected,disabled) { return E('span',{'class':'qs-radios'},items.map(function(item) { return E('label',{},[E('input',{type:'radio',name:name,value:item[0],checked:selected===item[0] || null,disabled:disabled || null,change:function(){self.updateProtocol();}}),' '+item[1]]); })); }
        var proto=uci.get('network','wan','proto') || 'dhcp';
        function mark(){return E('span',{'class':'freeisp-mark','aria-hidden':'true'},[E('i'),E('i'),E('i')]);}
        var root=E('div',{'class':'qs-window'},[
            E('link',{rel:'stylesheet',href:L.resource('freeisp/quickset.css')+'?v=day-night-3'}),
            E('div',{'class':'qs-heading'},[E('div',{},[E('h2',{},'Quick Set'),E('p',{},'Your network, configured.')]),E('span',{'class':'qs-status',role:'status'},'Settings loaded')]),
            E('div',{'class':'qs-route','aria-label':'Network connections'},[
                E('div',{'class':'qs-node'},[E('b',{},'01'),E('div',{},[E('strong',{},'Internet'),E('small',{},current.address || 'No address')])]),
                E('span',{'class':'qs-wire','aria-hidden':'true'}),E('div',{'class':'qs-router-mark','aria-label':'FreeISP router'},mark()),E('span',{'class':'qs-wire','aria-hidden':'true'}),
                E('div',{'class':'qs-node'},[E('b',{},'02'),E('div',{},[E('strong',{},'Local network'),E('small',{},lanIP)])]),
                E('span',{'class':'qs-online'+(wan.up?' is-up':'')},wan.up?'WAN connected':'WAN disconnected')
            ]),
            E('div',{'class':'qs-content'},[
                section('01 / Internet',[
                    radios('qs-proto',[['dhcp','Automatic'],['static','Static'],['pppoe','PPPoE']],proto,false),
                    row('IP address',input('wanIP',uci.get('network','wan','ipaddr') || current.address || '')),
                    row('Netmask',input('wanMask',uci.get('network','wan','netmask') || (current.mask ? data.address((4294967295 << (32-current.mask)) >>> 0) : '255.255.255.0'))),
                    row('Gateway',input('gateway',uci.get('network','wan','gateway') || route.nexthop || '')),
                    row('DNS servers',input('dns',[].concat(uci.get('network','wan','dns') || []).join(' '))),
                    row('PPPoE username',input('pppUser',uci.get('network','wan','username') || '')),
                    row('PPPoE password',input('pppPassword','','password')),
                    E('p',{'class':'qs-hint','id':'qs-password-hint'},'Leave empty to keep the existing password.'),
                    E('details',{'class':'qs-advanced'},[E('summary',{},'Connection details'),unavailable('MAC address',(devs[wan.l3_device] || devs[wan.device] || {}).macaddr || 'Unavailable'),link('Manage connection →',['network','network'])])
                ]),
                section('02 / Local network',[
                    row('Router IP',input('lanIP',lanIP)),row('Netmask',input('lanMask',lanMask)),
                    check('dhcp','DHCP server',uci.get('dhcp','lan','ignore')!=='1'),
                    row('DHCP range',input('range',range)),check('nat','NAT',!!zone && zone.masq==='1',!zone),
                    E('div',{'class':'qs-end'},[link('Port mapping →',['network','firewall','forwards']),link('Bridge / VLAN →',['network','freeisp_bridge'])])
                ]),
                section('03 / WiFi',[
                    E('div',{'class':'qs-empty-state'},[E('div',{},[E('strong',{},'Radios & wireless networks'),E('p',{},'Manage WiFi interfaces, security profiles, channels and connected clients.')])]),
                    link('Open WiFi →',['wifi','interfaces']),
                    E('p',{'class':'qs-hint'},'A supported radio and driver are required. The current VM has no WiFi hardware.')
                ]),
                section('04 / System',[
                    row('Router name',input('hostname',system ? system.hostname : 'FreeISP')),
                    E('div',{'class':'qs-system-links'},[link('VPN tunnel · Configure →',['network','network']),link('Password & access →',['system','admin'])]),
                    E('details',{'class':'qs-advanced'},[E('summary',{},'Maintenance'),E('div',{'class':'qs-end'},[link('Software updates',['system','package-manager']),link('Backup / reset',['system','flash'])])])
                ]),
                E('div',{'class':'qs-actions'},[
                    E('span',{'class':'qs-save-note'},'Review changes before applying.'),
                    E('button',{click:function(){window.location.reload();}},'Cancel'),
                    E('button',{'class':'qs-primary',click:function(){self.save(false);}},'Apply changes')
                ])
            ])
        ]);
        root.addEventListener('input',function(){root.querySelector('.qs-status').textContent='Unsaved changes';});
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
