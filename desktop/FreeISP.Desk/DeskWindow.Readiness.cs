using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace FreeISP.Desk {
 internal sealed partial class DeskWindow {
  readonly bool readinessTest=Environment.GetCommandLineArgs().Contains("--readiness-test");
  ulong activeNavigationId;
  bool navigationCompleted, closing, bypassPageCache;
  Uri retryTarget;
  int ReadyTimeoutMilliseconds { get { return readinessTest?1800:30000; } }

  bool CurrentNavigation(int generation,ulong id){return !closing&&!IsDisposed&&generation==navigationGeneration&&id==activeNavigationId;}

  async void NavigationStarting(object sender,CoreWebView2NavigationStartingEventArgs args){
   Uri target;
   if(closing||!Uri.TryCreate(args.Uri,UriKind.Absolute,out target)||(!IsHub(target)&&!SameRouter(target))){args.Cancel=true;return;}
   if(SameRouter(target)&&target.AbsolutePath=="/cgi-bin/luci/admin/network/freeisp_interfaces"&&approvedNavigation!=target.AbsoluteUri){args.Cancel=true;ShowInterfaces();return;}
   bool redirect=args.IsRedirected&&args.NavigationId==activeNavigationId;
   bool approved=approvedNavigation==target.AbsoluteUri;
   if(approved)approvedNavigation=null;
   if(!approved&&!redirect){navigationGeneration++;bypassPageCache=false;assetCache=null;}
   activeNavigationId=args.NavigationId;navigationCompleted=false;navigating=true;
   int generation=navigationGeneration;ulong id=activeNavigationId;
   if(IsHub(target))return;
   retryTarget=target;
   if(!approved)ShowProgress("Your network workspace","Reading the latest router settings…");
   // The deadline includes document loading, not only LuCI's later asynchronous rendering.
   if(!redirect&&!cacheTest)_=WatchRouterView(generation,id);
   if(approved||redirect)return;
   assetPreparation=PrepareNavigationAssets(generation,id,target);
   await assetPreparation;
  }

  async Task PrepareNavigationAssets(int generation,ulong id,Uri target){
   try{
    var next=new RouterAssetCache(Path.Combine(data,"RouterAssets"));await next.Prepare(router);
    if(CurrentNavigation(generation,id)&&SameRouter(target))assetCache=next;
   }catch(Exception ex){if(CurrentNavigation(generation,id)){navigating=false;ShowProgress("Connection unavailable","The interface could not open. "+ex.Message,true);}}
  }

  async void NavigationCompleted(object sender,CoreWebView2NavigationCompletedEventArgs args){
   int generation=navigationGeneration;ulong id=args.NavigationId;
   if(!CurrentNavigation(generation,id)||!navigating||preparingNavigation)return;
   try{
    if(!args.IsSuccess||args.HttpStatusCode>=400){
     if(!args.IsSuccess&&args.WebErrorStatus==CoreWebView2WebErrorStatus.OperationCanceled)return;
     navigating=false;ShowProgress("Connection unavailable",IsHub(browser.Source)?"The bundled workspace could not open. Reopen FreeISP Desk.":"Check the router address or SSH tunnel, then try again. Your local workspace is still available.",true);return;
    }
    navigationCompleted=true;
    if(!IsHub(browser.Source)){if(cacheTest){navigating=false;await CheckBrowserCache();}return;}
    RevealPage();
    if(IsInterfaces(browser.Source)){await SendInterfaceContext();return;}
    if(selfTest&&!readinessTest&&!liveRouterTest){await Task.Delay(400);if(CurrentNavigation(generation,id))await RunSelfTest(args.IsSuccess);return;}
    await Send(new{type="routers",routers=PublicRouters()});
   }catch(Exception ex){if(CurrentNavigation(generation,id)){navigating=false;ShowProgress("Interface unavailable","The page could not finish opening. "+ex.Message,true);}}
  }

  void RevealPage(){navigating=false;loading.Visible=false;browser.Visible=true;connectionLabel.Text=IsHub(browser.Source)?"Local workspace":router?.Authority;}

  void ViewTimedOut(){
   navigating=false;
   ShowProgress("Router page did not finish loading","Try again to fetch fresh interface files, or return to Device Hub. Your router login is kept.",true);
  }

  async Task WatchRouterView(int generation,ulong id){
   var elapsed=Stopwatch.StartNew();
   try{
    while(CurrentNavigation(generation,id)&&navigating){
     int remaining=ReadyTimeoutMilliseconds-(int)elapsed.ElapsedMilliseconds;
     if(remaining<=0){ViewTimedOut();return;}
     if(navigationCompleted){
      var script=browser.CoreWebView2.ExecuteScriptAsync("!document.querySelector('#view') || !!document.querySelector('#view h2, #view .cbi-map, #view table, input[name=luci_password]')");
      var completed=await Task.WhenAny(script,Task.Delay(remaining));
      if(!CurrentNavigation(generation,id)||!navigating)return;
      if(completed!=script){ViewTimedOut();return;}
      string ready=await script;
      if(!CurrentNavigation(generation,id)||!navigating)return;
      if(ready=="true"){RevealPage();return;}
     }
     await Task.Delay(100);
    }
   }catch(Exception ex){if(CurrentNavigation(generation,id)&&navigating){navigating=false;ShowProgress("Interface unavailable","The page could not finish opening. "+ex.Message,true);}}
  }

  async Task WaitForCheck(Func<bool> condition,string message,int milliseconds=8000){
   var elapsed=Stopwatch.StartNew();
   while(!condition()){if(elapsed.ElapsedMilliseconds>=milliseconds)throw new Exception(message);await Task.Delay(50);}
  }

  async Task RunReadinessTest(){
   var checks=new Dictionary<string,bool>();
   try{
    var cookie=browser.CoreWebView2.CookieManager.CreateCookie("desk_fixture","kept",router.Host,"/");cookie.IsHttpOnly=true;browser.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
    var target=new Uri(router,"/cgi-bin/luci/admin/freeisp");
    await NavigateRouter(target);
    await WaitForCheck(()=>retry.Visible&&progressTitle.Text=="Router page did not finish loading","Stuck view did not produce bounded recovery controls.");
    checks["stuck_view_timeout"]=loading.Visible&&browser.Visible&&Controls.GetChildIndex(loading)<Controls.GetChildIndex(browser)&&returnHub.Visible;
    byte[] cached;string type;
    checks["stuck_asset_cached"]=assetCache.TryRead(new Uri(router,"/luci-static/freeisp/readiness.js"),out cached,out type);
    using(var client=new HttpClient()){await client.GetStringAsync(new Uri(router,"/fixture/repair"));}
    retry.PerformClick();
    await WaitForCheck(()=>!loading.Visible&&!navigating,"Fresh retry did not render the repaired view.");
    checks["fresh_retry_rendered"]=await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#view h2').textContent==='Router ready'")=="true";
    using(var client=new HttpClient()){
     var stats=json.Deserialize<Dictionary<string,object>>(await client.GetStringAsync(new Uri(router,"/fixture/stats")));
     checks["same_revision_cache_bypassed_once"]=Convert.ToInt32(stats["assets"])==2;
     checks["login_cookie_preserved"]=Convert.ToInt32(stats["authenticatedHtml"])==2;
    }
    await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp?next=1"));
    await WaitForCheck(()=>!loading.Visible&&!navigating,"Normal navigation failed after recovery.");
    using(var client=new HttpClient()){
     var stats=json.Deserialize<Dictionary<string,object>>(await client.GetStringAsync(new Uri(router,"/fixture/stats")));
     checks["repaired_asset_reused"]=Convert.ToInt32(stats["assets"])==2&&!bypassPageCache;
    }
    await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp?stuck=1"));
    await WaitForCheck(()=>navigationCompleted&&navigating,"Superseded view did not start.");
    controls.Controls.OfType<System.Windows.Forms.Button>().Single(b=>b.Text=="Device Hub").PerformClick();
    await WaitForCheck(()=>IsHub(browser.Source)&&!loading.Visible,"Local hub did not recover while the view was pending.");
    await Task.Delay(ReadyTimeoutMilliseconds+300);
    checks["superseded_watchdog_ignored"]=IsHub(browser.Source)&&!loading.Visible&&!retry.Visible;
    await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp?slow=1"));
    await WaitForCheck(()=>retry.Visible&&progressTitle.Text=="Router page did not finish loading","Stalled document did not time out.");
    checks["stalled_navigation_timeout"]=!navigationCompleted&&returnHub.Visible;
    controls.Controls.OfType<System.Windows.Forms.Button>().Single(b=>b.Text=="Device Hub").PerformClick();
    await WaitForCheck(()=>IsHub(browser.Source)&&!loading.Visible,"Cancelled navigation displaced the hub.");
    await Task.Delay(ReadyTimeoutMilliseconds+300);
    checks["cancelled_completion_ignored"]=IsHub(browser.Source)&&!loading.Visible;
    bool passed=checks.Values.All(value=>value);
    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"readiness-test.json"),json.Serialize(new{passed,checks}));Environment.ExitCode=passed?0:1;Close();
   }catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"readiness-test.json"),json.Serialize(new{passed=false,checks,error=ex.ToString()}));Environment.ExitCode=1;Close();}
  }
 }
}
