using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
namespace FreeISP.Desk {
 internal sealed partial class DeskWindow {
  readonly bool liveRouterTest=Environment.GetCommandLineArgs().Contains("--live-router-test");
  async Task WaitForScript(string script,string failure,int attempts=160){for(int i=0;i<attempts;i++){if(await browser.CoreWebView2.ExecuteScriptAsync(script)=="true")return;await Task.Delay(100);}throw new Exception(failure);}
  async Task RunLiveRouterTest(){
   try{
    var target=router;string password=Environment.GetEnvironmentVariable("FREEISP_TEST_PASSWORD");Environment.SetEnvironmentVariable("FREEISP_TEST_PASSWORD",null);
    if(string.IsNullOrEmpty(password))throw new Exception("Test password missing.");
    ShowHub();await WaitForCheck(()=>IsDeviceHub(browser.Source)&&!loading.Visible,"Local Hub did not render.");
    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#address').value="+json.Serialize(target.AbsoluteUri)+";document.querySelector('#username').value='root';document.querySelector('#password').value="+json.Serialize(password)+";document.querySelector('#remember').checked=true;document.querySelector('#connect').click();");password=null;
    await WaitForCheck(()=>IsInterfaces(browser.Source)&&!loading.Visible&&!navigating,"Local interface page did not open after sign in.",25000);
    await WaitForScript("document.querySelector('#connection-strip').dataset.state==='live' && !!document.querySelector('#interface-rows [data-interface]')","Real interface data did not arrive.");
    await WaitForScript("document.querySelector('#rx-rate').textContent!=='—'","Traffic rates did not update.");
    var nativeClient=routerData;
    // Opening the bundled page must not wait for even an unavailable router.
    routerData=null;var timer=Stopwatch.StartNew();ShowInterfaces();
    await WaitForCheck(()=>IsInterfaces(browser.Source)&&!loading.Visible&&!navigating,"Local layout waited for router.");
    await WaitForScript("!!document.querySelector('#traffic-chart') && !!document.querySelector('#interface-rows')","Local layout missing.");
    await WaitForScript("document.querySelector('#connection-strip').dataset.state==='error'","Offline state not shown.");timer.Stop();
    routerData=nativeClient;
    ShowHub();await WaitForCheck(()=>IsDeviceHub(browser.Source)&&!loading.Visible,"Hub did not reopen.");
    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#routers .select').click();document.querySelector('#connect').click();");
    await WaitForCheck(()=>IsInterfaces(browser.Source)&&!loading.Visible&&!navigating,"Saved-password reconnect failed.",25000);
    await WaitForScript("document.querySelector('#connection-strip').dataset.state==='live'","Live data did not recover.");
    await WaitForScript("document.querySelectorAll('.freeisp-sidebar nav button').length===21", "Full local sidebar is missing.");
    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-route=freeisp]').click()");
    await WaitForCheck(()=>preparingNavigation||!IsHub(browser.Source),"Router menu did not start.");
    if(loading.Visible)throw new Exception("Menu navigation covered the existing sidebar.");
    await WaitForCheck(()=>!IsHub(browser.Source)&&!loading.Visible&&!navigating,"Router workspace did not open.",30000);
    await WaitForScript("!!window.freeispNavigation && document.querySelectorAll('.freeisp-sidebar a').length===21", "Shared router navigation is missing.");
    await browser.CoreWebView2.ExecuteScriptAsync("window.__deskSameDocument='ready';document.querySelector('.freeisp-sidebar a[href$=freeisp_pppoe]').click()");
    await WaitForScript("document.querySelector('#view').dataset.freeispState==='ready' && !!document.querySelector('.pp-window')", "PPPoE workspace did not open.");
    await WaitForScript("window.__deskSameDocument==='ready' && document.querySelectorAll('.freeisp-sidebar a').length===21", "Menu click restarted the router document.");
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"live-router-test.json"),json.Serialize(new{passed=true,hubLogin=true,savedPasswordReconnect=true,localInterfacesRendered=true,realCounters=true,trafficRates=true,offlineLayoutMilliseconds=timer.ElapsedMilliseconds,offlineRemainsUsable=true,fullSidebarPreserved=true,sharedMenuNavigation=true,pppoeRendered=true}));Environment.ExitCode=0;Close();
   }catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"live-router-test.json"),json.Serialize(new{passed=false,error=ex.Message}));Environment.ExitCode=1;Close();}
  }
 }
}
