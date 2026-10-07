const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const data = new Function('baseclass', fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/firewall-data.js', 'utf8'))({extend: x => x});
const clone = x => structuredClone(x);
const section = (sid, type, values) => ({'.name': sid, '.type': type, ...values});
const zones = ['lan', 'wan', 'management'].map(name => section('zone_' + name, 'zone', {name, input: 'REJECT', forward: 'REJECT', output: 'ACCEPT'}));
const list = section('trusted_set', 'ipset', {name: 'trusted', family: 'ipv4', match: ['src_net'], entry: ['192.0.2.0/24']});
const baseline = [...zones, list];
const base = {name: 'Test rule', enabled: '1', family: 'ipv4', src: 'lan', dest: 'wan', target: 'ACCEPT', proto: 'tcp', src_ip: '', dest_ip: '', src_port: '', dest_port: '', ipset: ''};
const valid = (v = {}, kind = 'filter', ss = baseline, old) => data.validate({...base, ...v}, kind, ss, old);
const natBase = {dest: '', target: 'SNAT', snat_ip: '203.0.113.2', src: 'wan'};
const fixtures = [];
function fixture(id, kind, values) { const v = valid(values, kind); fixtures.push(section(id, {dnat:'redirect',snat:'nat',ipset:'ipset'}[kind] || 'rule', v)); return v; }

assert.deepEqual(data.tabs, ['Filter Rules', 'NAT', 'Mangle', 'Raw', 'Service Ports', 'Connections', 'Address Lists', 'Layer7 Protocols']);
assert.deepEqual(data.list('tcp, udp\n icmp'), ['tcp','udp','icmp']);
assert.deepEqual(data.list(['tcp', 'udp']), ['tcp','udp']);
assert.equal(data.tabFor(section('x', 'zone', {})), null);
for (const [type, target, tab] of [['rule','ACCEPT','Filter Rules'],['rule','MARK','Mangle'],['rule','DSCP','Mangle'],['rule','NOTRACK','Raw'],['rule','HELPER','Service Ports'],['rule','unknown','Filter Rules'],['redirect','DNAT','NAT'],['nat','SNAT','NAT'],['ipset','','Address Lists']]) assert.equal(data.tabFor(section('x', type, {target})), tab);

// Validate both IP families, compressed IPv6 and embedded IPv4 independently
// against Node's IP parser, then enforce CIDR bounds and family compatibility.
for (const ip of ['0.0.0.0','255.255.255.255','192.0.2.1','::','::1','2001:db8::1','2001:db8:0:1:2:3:4:5','::ffff:192.0.2.1','2001:db8::192.0.2.1']) assert.equal(data.ipFamily(ip), net.isIP(ip));
for (const ip of ['','256.0.0.1','192.0.2','01.2.3.4','localhost','1.2.3.4/33','1.2.3.4/-1','1.2.3.4/24/1',':::','1::2::3','2001:db8::/129','1:2:3:4:5:6:7','1:2:3:4:5:6:7:8:9','::ffff:999.1.1.1','fe80::1%eth0','1:2:3:4:5:6:7:8::']) assert.equal(data.ipFamily(ip), 0, ip);
assert.equal(data.ipFamily('192.0.2.0/0'), 4);
assert.equal(data.ipFamily('2001:db8::/128'), 6);
for (const value of ['256.1.1.1','192.0.2.0/33','bad','2001:db8::1']) assert.throws(() => valid({src_ip:value}), /address|family/);
assert.deepEqual(valid({family:'any',src_ip:'192.0.2.1 2001:db8::1'}).src_ip, ['192.0.2.1','2001:db8::1']);
assert.throws(() => valid({family:'any',src_ip:'192.0.2.1',dest_ip:'2001:db8::1'}), /Conflicting/);
assert.throws(() => valid({family:'any',src_ip:'192.0.2.1 2001:db8::1',ipset:'trusted'}), /would ignore/);
assert.throws(() => valid({src:'missing'}), /Unknown src zone/);
assert.equal(valid({src:'*',dest:''}).src, '*');
assert.equal(valid({src:'',dest:'wan'}).src, '');
assert.throws(() => valid({src:'',dest:''}), /traffic direction/);
assert.throws(() => valid({src:'wan'}, 'filter', zones.map(s => s.name === 'wan' ? {...s,family:'ipv6'} : s)), /Conflicting/);
assert.throws(() => valid({enabled:'yes'}), /enabled/);
assert.throws(() => valid({target:'JUMP'}), /action/);
assert.throws(() => valid({proto:'nonsense'}), /protocol/);
assert.throws(() => valid({proto:'256'}), /protocol/);
assert.throws(() => valid({proto:'all tcp'}), /combined/);
assert.deepEqual(valid({proto:'6,17'}).proto,['tcp','udp']);
assert.deepEqual(valid({dest_port:'080,443,8000:8080'}).dest_port,['80','443','8000-8080']);
for (const p of ['0','65536','443-80','-1','1.2','abc']) assert.throws(() => valid({dest_port:p}), /ports/);
for (const proto of ['all','icmp','ipv6-icmp','tcp icmp','sctp']) assert.throws(() => valid({proto,dest_port:'443'}), /requires TCP/);
assert.throws(() => valid({proto:'ipv6-icmp'}), /Conflicting/);
assert.throws(() => valid({ipset:'missing'}), /address list/);
assert.throws(() => valid({family:'ipv6',ipset:'trusted'}), /Conflicting/);

fixture('filter_accept','filter',{name:'Fixture allow',ipset:'trusted',dest_port:'443'});
fixture('filter_drop','filter',{name:'Fixture deny',target:'DROP',src_ip:'198.51.100.2'});
fixture('filter_v6','filter',{name:'Fixture v6',family:'ipv6',proto:'ipv6-icmp',src_ip:'2001:db8::/64'});
fixture('mark','mangle',{name:'Fixture mark',target:'MARK',set_mark:'0x1/0xff',set_dscp:''});
fixture('dscp','mangle',{name:'Fixture DSCP',target:'DSCP',set_dscp:'AF41',set_mark:''});
for (const set_mark of ['', '-1', '0x100000000','4294967296','1/4294967296','0xGG']) assert.throws(() => valid({target:'MARK',set_mark},'mangle'), /mark/);
assert.equal(valid({target:'MARK',set_mark:'0'},'mangle').set_mark,'0');
for (const set_dscp of ['', '-1','64','AF44','CS8','2.5']) assert.throws(() => valid({target:'DSCP',set_dscp},'mangle'), /DSCP/);
assert.equal(valid({target:'DSCP',set_dscp:'0'},'mangle').set_dscp,'0');
assert.throws(() => valid({target:'MARK',set_mark:'1',set_dscp:'EF'},'mangle'), /also/);
fixture('notrack','raw',{name:'Fixture untracked',target:'NOTRACK',dest:'',proto:'udp',dest_port:'123'});
fixture('helper','helper',{name:'Fixture FTP helper',target:'HELPER',dest:'',proto:'tcp',dest_port:'21',set_helper:'ftp'});
for (const kind of ['raw','helper']) for (const src of ['','*']) assert.throws(() => valid({target:kind === 'raw'?'NOTRACK':'HELPER',src,dest:'',set_helper:kind === 'helper'?'ftp':''},kind), /source zone/);
assert.throws(() => valid({target:'HELPER',dest:'',set_helper:''},'helper'), /helper/);
assert.throws(() => valid({target:'NOTRACK'},'raw'), /destination zone/);

const dnat = fixture('forward','dnat',{name:'Fixture forward',src:'wan',dest:'lan',target:'DNAT',src_dport:'8080',dest_port:'80',dest_ip:'192.0.2.2'});
assert.equal(dnat.src_dport,'8080');
assert.equal(valid({...dnat,dest:''},'dnat').dest,'');
assert.throws(() => valid({...dnat,src:'*'},'dnat'), /source zone/);
assert.throws(() => valid({...dnat,dest_ip:''},'dnat'), /internal destination/);
assert.throws(() => valid({...dnat,dest_ip:'192.0.2.0/24'},'dnat'), /literal IP/);
for (const k of ['src_port','dest_port','src_dport']) assert.throws(() => valid({...dnat,[k]:'80 443'},'dnat'), /one port/);
assert.throws(() => valid({...dnat,src_ip:'192.0.2.1 192.0.2.2'},'dnat'), /one address/);
fixture('snat','snat',{name:'Fixture source NAT',...natBase,src_ip:'192.0.2.0/24'});
fixture('masquerade','snat',{name:'Fixture masquerade',...natBase,target:'MASQUERADE',snat_ip:'',snat_port:''});
assert.throws(() => valid({...natBase,snat_ip:'',snat_port:''},'snat'), /needs/);
assert.throws(() => valid({...natBase,target:'MASQUERADE'},'snat'), /Masquerade/);
assert.throws(() => valid({...natBase,target:'MASQUERADE',snat_ip:'',snat_port:'1000'},'snat'), /Masquerade/);
assert.equal(valid({...natBase,snat_ip:'',snat_port:'1000'},'snat').snat_port,'1000');

const newSet = fixture('address_v4','ipset',{name:'fixture4',family:'ipv4',match:'src_ip',entry:'192.0.2.0/24\n198.51.100.1'});
assert.deepEqual(newSet.match,['src_net']);
fixture('address_v6','ipset',{name:'fixture6',family:'ipv6',match:'dest_ip',entry:'2001:db8::/64'});
assert.throws(() => valid({...newSet,family:'any'},'ipset'), /one address family/);
assert.throws(() => valid({...newSet,entry:'::1'},'ipset'), /family/);
assert.throws(() => valid({...newSet,name:'bad name'},'ipset'), /list name/);
assert.throws(() => valid({...newSet,name:'trusted'},'ipset'), /already exists/);
assert.throws(() => valid({...newSet,match:'src_ip dest_ip'},'ipset'), /single/);
const ref = section('ref','rule',{...base,ipset:'trusted',custom_option:'preserve',limit:'10/second'});
assert.deepEqual(data.dependencies([ref,{...ref,'.name':'other',ipset:'!trusted dest',name:'Other'}],'trusted'),['Test rule','Other']);
assert.throws(() => data.validate({...list,name:'renamed'},'ipset',[...baseline,ref],list), /in use/);
assert.throws(() => data.validateDraft([...baseline,ref],[...zones,ref]), /still referenced/);
assert.doesNotThrow(() => data.validateDraft([...baseline,ref],zones));
assert.throws(() => data.validateDraft([...baseline,ref],[...zones,{...list,family:'ipv6',entry:['::1']},ref]), /Conflicting/);

// Complete create/edit/delete/reorder round trip against a UCI-compatible store.
// Assert unknown options, zones, includes, defaults, and forwarding are intact.
const untouched = [section('defaults','defaults',{input:'REJECT'}),...zones,section('include','include',{path:'/etc/custom.nft'}),section('forwarding','forwarding',{src:'lan',dest:'wan'})];
const before = [...untouched,list,ref,section('obsolete','rule',{...base,name:'Remove me'})];
const draft = clone(before).filter(s => s['.name'] !== 'obsolete');
Object.assign(draft.find(s => s['.name'] === 'ref'),{dest_port:['443'],src_ip:[]});
draft.splice(draft.indexOf(draft.find(s => s['.name'] === 'ref')),0,section('draft_new','rule',fixtures[1]));
draft.find(s => s['.name'] === 'filter_drop')['.name'] = 'draft_new';
// Section metadata must not leak into values.
draft.find(s => s['.name'] === 'draft_new')['.index'] = 900;
data.validateDraft(before,draft);
const ops = data.operations(before,draft), saved = clone(before), calls = [];
const uci = {
    add(config,type) { calls.push(['add',config]); const sid='generated_'+saved.length; saved.push(section(sid,type,{})); return sid; },
    set(config,sid,key,value) { calls.push(['set',config]); const s=saved.find(s=>s['.name']===sid); if(value==null || value==='') delete s[key]; else s[key]=clone(value); },
    remove(config,sid) { calls.push(['remove',config]); saved.splice(saved.findIndex(s=>s['.name']===sid),1); },
    move(config,sid,target,after) { calls.push(['move',config]); const i=saved.findIndex(s=>s['.name']===sid); if(i<0)return false; const [s]=saved.splice(i,1); if(target==null)saved.push(s); else {const n=saved.findIndex(s=>s['.name']===target);if(n<0)return false;saved.splice(n+(after?1:0),0,s);} return true; }
};
const ids=data.stage(uci,ops);
assert(calls.every(call=>call[1]==='firewall'));
assert.deepEqual(saved.filter(s=>untouched.some(u=>u['.name']===s['.name'])),untouched);
assert.equal(saved.find(s=>s['.name']==='ref').custom_option,'preserve');
assert.equal(saved.find(s=>s['.name']==='ref').limit,'10/second');
assert.deepEqual(saved.map(s=>s['.name']),draft.map(s=>ids[s['.name']]||s['.name']));
assert.deepEqual(saved.find(s=>s['.name']==='ref').dest_port,['443']);
assert.equal(saved.find(s=>s['.name']==='ref').src_ip,undefined);
assert.equal(saved.find(s=>s['.name']===ids.draft_new)['.index'],undefined);
assert.deepEqual(data.operations(before,clone(before)),[]);
const reordered=clone(saved); const a=reordered.pop();reordered.splice(untouched.length,0,a);
const reorder=data.operations(saved,reordered); assert.equal(reorder.length,1);assert.equal(reorder[0].kind,'order');data.stage(uci,reorder);
assert.deepEqual(saved.map(s=>s['.name']),reordered.map(s=>s['.name']));
assert.throws(()=>data.stage(uci,[{kind:'set',section:zones[0],values:{input:'ACCEPT'}}]),/Only firewall/);

if(process.argv.includes('--fixtures')) {
    console.log(JSON.stringify({zones,ipsets:[list],cases:fixtures},null,2));
} else console.log('Firewall model: address and family validation, targets, NAT semantics, subnet sets, dependency guards, preservation and UCI ordering passed.');
