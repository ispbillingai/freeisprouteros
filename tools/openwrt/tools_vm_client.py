"""Client restricted to the disposable local router Tools test VM."""
import json
import time
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SID='0'*32

def rpc(obj,method,args=None,required=True):
    req=urllib.request.Request('http://127.0.0.1:18940/ubus',data=json.dumps({
        'jsonrpc':'2.0','id':1,'method':'call','params':[SID,obj,method,args or {}]
    }).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=40) as response: value=json.load(response)
    result=value.get('result',[value.get('error',{}).get('code',-1)])
    if required and result[0]!=0:raise RuntimeError(f'{obj}.{method}: {result}')
    return result[1] if len(result)>1 else result[0]

def execute(command,args=None):
    return rpc('file','exec',{'command':command,'params':args or []})

def login():
    global SID
    SID='0'*32
    for attempt in range(60):
        try:
            SID=rpc('session','login',{'username':'root','password':'FreeISP-Tools-Local-Test-Only'})['ubus_rpc_session']
            return
        except Exception:
            if attempt==59:raise
            time.sleep(2)
