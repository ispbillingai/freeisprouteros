import * as fs from 'fs';
import { cursor } from 'uci';
let c=cursor(), target=c.get('freeisp_tools','netwatch','host'), interval=+c.get('freeisp_tools','netwatch','interval');
if(!match(target || '',/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/) || interval<10 || interval>3600) die('Invalid Netwatch settings');
let previous=null;
while(true) {
 let p=fs.popen('/usr/bin/timeout -s KILL 5 ping -n -c 1 -W 2 '+target+' 2>&1','r');
 let output=p.read('all'), up=p.close()==0, now=time();
 if(previous!=up) system('logger -t freeisp-netwatch '+(up?'UP':'DOWN')+' '+target);
 previous=up;
 fs.writefile('/var/run/freeisp-netwatch.json.new',sprintf('%J',{host:target,up:up,checked_at:now,interval:interval,output:output}));
 fs.rename('/var/run/freeisp-netwatch.json.new','/var/run/freeisp-netwatch.json');
 sleep(interval*1000);
}
