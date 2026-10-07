using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
namespace FreeISP.Desk {
 internal sealed partial class DeskWindow {
  readonly bool liveRouterTest=Environment.GetCommandLineArgs().Contains("--live-router-test");
  async Task RunLiveRouterTest(){
   try{
    var target=router;
    string password=Environment.GetEnvironmentVariable("FREEISP_TEST_PASSWORD");
    Environment.SetEnvironmentVariable("FREEISP_TEST_PASSWORD",null);
    if(string.IsNullOrEmpty(password))throw new Exception("Test password missing.");
    ShowHub();
    await WaitForCheck(()=>IsHub(browser.Source)&&!loading.Visible,"Local Hub did not render.");
    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#address').value="+json.Serialize(target.AbsoluteUri)+";document.querySelector('#username').value='root';document.querySelector('#password').value="+json.Serialize(password)+";document.querySelector('#remember').checked=true;document.querySelector('#connect').click();");
    password=null;
    await WaitForCheck(()=>!IsHub(browser.Source)&&!loading.Visible&&!navigating,"Live router page did not render after Hub login.",38000);
    bool quickSet=await browser.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#qs-hostname') && document.querySelector('#view').textContent.includes('Settings loaded')")=="true";
    ShowHub();
    await WaitForCheck(()=>IsHub(browser.Source)&&!loading.Visible,"Hub did not reopen.");
    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#routers .select').click();document.querySelector('#connect').click();");
    await WaitForCheck(()=>!IsHub(browser.Source)&&!loading.Visible&&!navigating,"Saved-password reconnect failed.",38000);
    bool savedReconnect=await browser.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#qs-hostname')")=="true";
    quickSet=quickSet&&savedReconnect;
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"live-router-test.json"),json.Serialize(new{passed=quickSet,hubLogin=true,savedPasswordReconnect=savedReconnect,quickSetRendered=quickSet,loadingDismissed=!loading.Visible}));
    Environment.ExitCode=quickSet?0:1;Close();
   }catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"live-router-test.json"),json.Serialize(new{passed=false,error=ex.Message}));Environment.ExitCode=1;Close();}
  }
 }
}