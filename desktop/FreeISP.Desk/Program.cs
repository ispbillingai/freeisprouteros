using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
namespace FreeISP.Desk {
 internal static class Program {
  internal static string Assets;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetDllDirectory(string path);
  [STAThread] static void Main(){
   try{
    var assembly=Assembly.GetExecutingAssembly();
    Assets=Path.Combine(Environment.GetCommandLineArgs().Contains("--self-test")?AppDomain.CurrentDomain.BaseDirectory:Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FreeISP","Desk","Components",assembly.ManifestModule.ModuleVersionId.ToString("N"));
    Directory.CreateDirectory(Path.Combine(Assets,"Hub"));
    foreach(var resource in assembly.GetManifestResourceNames().Where(n=>n.StartsWith("FreeISP.Bundle."))){
     string relative=resource.Substring("FreeISP.Bundle.".Length);if(relative.StartsWith("Hub."))relative=Path.Combine("Hub",relative.Substring(4));
     string path=Path.Combine(Assets,relative);
     if(!File.Exists(path))using(var input=assembly.GetManifestResourceStream(resource))using(var output=File.Create(path))input.CopyTo(output);
    }
    if(!SetDllDirectory(Assets))throw new Exception("Could not load the bundled browser components.");
    AppDomain.CurrentDomain.AssemblyResolve+=(s,e)=>{string name=new AssemblyName(e.Name).Name;if(name!="Microsoft.Web.WebView2.Core"&&name!="Microsoft.Web.WebView2.WinForms")return null;return Assembly.LoadFrom(Path.Combine(Assets,name+".dll"));};
    Launch();
   }catch(Exception ex){if(Environment.GetCommandLineArgs().Contains("--self-test")){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test-error.txt"),ex.ToString());Environment.Exit(1);}MessageBox.Show("FreeISP Desk could not start.\n\n"+ex.Message,"FreeISP Desk",MessageBoxButtons.OK,MessageBoxIcon.Error);}
  }
  [MethodImpl(MethodImplOptions.NoInlining)] static void Launch(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new DeskWindow());}
 }
 public class RouterEntry { public string name {get;set;} public string address {get;set;} public string username {get;set;} public string source {get;set;} }
 internal sealed class DeskWindow:Form {
  const string Hub="https://freeisp-desk.local/index.html";
  readonly WebView2 browser=new WebView2{Dock=DockStyle.Fill};
  readonly JavaScriptSerializer json=new JavaScriptSerializer();
  readonly string data=Path.Combine(Environment.GetCommandLineArgs().Contains("--self-test")?AppDomain.CurrentDomain.BaseDirectory:Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FreeISP","Desk");
  readonly Panel controls=new Panel{Dock=DockStyle.Top,Height=40,BackColor=Color.FromArgb(11,36,53),Visible=false};
  Uri router; bool busy; bool scanning;
  readonly bool selfTest=Environment.GetCommandLineArgs().Contains("--self-test");
  readonly bool routerSelfTest=Environment.GetCommandLineArgs().Contains("--tools-router-test");
  public DeskWindow(){
   Text="FreeISP Desk";Size=new Size(1320,900);MinimumSize=new Size(960,650);StartPosition=FormStartPosition.CenterScreen;
   Icon=System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
   if(selfTest){ShowInTaskbar=false;Opacity=0;var timer=new Timer{Interval=45000};timer.Tick+=(s,e)=>{File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test.json"),"{\"passed\":false,\"error\":\"timeout\"}");Environment.Exit(1);};timer.Start();}
   var home=new Button{Text="← Device Hub",Left=12,Top=6,Width=120,Height=28};home.Click+=(s,e)=>ShowHub();
   var reload=new Button{Text="Reload",Left=140,Top=6,Width=80,Height=28};reload.Click+=(s,e)=>browser.Reload();
   var logout=new Button{Text="Disconnect",Left=228,Top=6,Width=95,Height=28};logout.Click+=async(s,e)=>{router=null;browser.CoreWebView2.Stop();await browser.CoreWebView2.Profile.ClearBrowsingDataAsync();ShowHub();};
   var tools=new Button{Text="Router Tools",Left=331,Top=6,Width=110,Height=28};tools.Click+=(s,e)=>{if(router!=null)browser.CoreWebView2.Navigate(new Uri(router,"/cgi-bin/luci/admin/network/freeisp_tools").AbsoluteUri);};
   controls.Controls.AddRange(new Control[]{home,reload,logout,tools});Controls.Add(browser);Controls.Add(controls);
   Shown+=async(s,e)=>{try{
    Directory.CreateDirectory(data);
    await browser.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null,Path.Combine(data,"Browser")));
    var core=browser.CoreWebView2;
    if(selfTest){core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);core.WebResourceRequested+=(resourceSender,resourceEvent)=>{Uri u;if(!Uri.TryCreate(resourceEvent.Request.Uri,UriKind.Absolute,out u)||(!IsHub(u)&&!(routerSelfTest&&u.Scheme=="http"&&u.Host=="127.0.0.1"&&u.Port==18940)))resourceEvent.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(),503,"Offline test","");};}
    string hubFolder=Path.Combine(Program.Assets,"Hub");
    foreach(string file in new[]{"index.html","hub.css","hub.js"})
     if(!File.Exists(Path.Combine(hubFolder,file)))throw new FileNotFoundException("A bundled app file is missing. Download FreeISP Desk again. Missing: Hub/"+file);
    core.SetVirtualHostNameToFolderMapping("freeisp-desk.local",hubFolder,CoreWebView2HostResourceAccessKind.DenyCors);
    core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
    core.WebMessageReceived+=HandleMessage;
    core.NavigationStarting+=(sender,args)=>{Uri target;if(!Uri.TryCreate(args.Uri,UriKind.Absolute,out target)||(!IsHub(target)&&!SameRouter(target)))args.Cancel=true;};
    core.NewWindowRequested+=(sender,args)=>args.Handled=true;
    core.NavigationCompleted+=async(sender,args)=>{
     if(IsHub(browser.Source)){controls.Visible=false;if(selfTest){await Task.Delay(400);await RunSelfTest(args.IsSuccess);return;}if(!args.IsSuccess){MessageBox.Show("The bundled Device Hub could not load: "+args.WebErrorStatus+". Reopen the app or download it again. No internet or router connection is needed for this screen.",Text);return;}await Send(new{type="routers",routers=ReadRouters()});}
     else if(!args.IsSuccess){ShowHub();MessageBox.Show("Could not reach the router. Check its address and your SSH tunnel. Certificate checks remain enabled.",Text);}
    };
    ShowHub();
   }catch(Exception ex){if(selfTest){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test-error.txt"),ex.ToString());Environment.Exit(1);}MessageBox.Show("FreeISP Desk could not start. Install Microsoft Edge WebView2 Runtime if it is missing.\n\n"+ex.Message,Text,MessageBoxButtons.OK,MessageBoxIcon.Error);}};
  }
  async Task RunSelfTest(bool navigationSucceeded){
   try{
    var checks=new Dictionary<string,bool>();checks["offline_navigation"]=navigationSucceeded;
    string rendered="false";
    for(int attempt=0;attempt<20&&rendered!="true";attempt++){rendered=await browser.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('#connection') && !!document.querySelector('#scan') && !!window.chrome.webview && document.querySelector('.original-logo').naturalWidth>0 && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && !document.querySelector('#connect').disabled");if(rendered!="true")await Task.Delay(100);}
    checks["offline_hub_and_logo"]=rendered=="true";
    if(File.Exists(Path.Combine(data,"self-test.marker"))){
     checks["saved_router_survives_restart"]=ReadRouters().Any(r=>r.name=="Offline test router"&&r.address=="https://192.0.2.1/");
     checks["theme_survives_restart"]=await browser.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme === 'night'")=="true";
    }
    checks["address_valid"]=Address("192.168.1.1").AbsoluteUri=="https://192.168.1.1/"&&Address("http://127.0.0.1:8874").Port==8874;
    bool rejected=true;foreach(var input in new[]{"ftp://router","https://user:password@router","https://freeisp-desk.local",""}){try{Address(input);rejected=false;}catch{}}
    checks["invalid_addresses_rejected"]=rejected;
    foreach(var check in await RouterConnection.SelfTest())checks["connection_"+check.Key]=check.Value;
    var list=new List<RouterEntry>{new RouterEntry{name="Offline test router",address="https://192.0.2.1/",username="root",source="Saved"}};
    File.WriteAllText(Path.Combine(data,"routers.json"),json.Serialize(list));checks["saved_router_round_trip"]=ReadRouters().Single().address==list[0].address;
    await Send(new{type="routers",routers=ReadRouters()});await Task.Delay(100);
    checks["saved_router_rendered"]=await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#routers').textContent.includes('Offline test router')")=="true";
    checks["theme_saved"]=await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#night').click();localStorage.getItem('freeisp-desk-theme') === 'night' && document.documentElement.dataset.theme === 'night'")=="true";
    if(routerSelfTest){
     router=Address("http://127.0.0.1:18940");
     string value=await RouterConnection.Authenticate(router,"root","FreeISP-Tools-Local-Test-Only");checks["real_router_login"]=!string.IsNullOrEmpty(value);
     var cookie=browser.CoreWebView2.CookieManager.CreateCookie("sysauth_http",value,router.Host,"/cgi-bin/luci/");cookie.IsHttpOnly=true;browser.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
     controls.Visible=true;controls.Controls.OfType<Button>().Single(b=>b.Text=="Router Tools").PerformClick();
     bool loaded=false;for(int attempt=0;attempt<100&&!loaded;attempt++){await Task.Delay(100);loaded=await browser.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.fi-tool-list button').length===20")=="true";}
     checks["real_router_tools_button"]=loaded;
     if(loaded){
      await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-tool=ping]').click();document.querySelector('.fi-tool-fields input').value='127.0.0.1';document.querySelector('.fi-tool-actions button').click()");
      bool replied=false;for(int attempt=0;attempt<100&&!replied;attempt++){await Task.Delay(100);replied=await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('.fi-tool-output').textContent.includes('0% packet loss')")=="true";}checks["real_router_ping"]=replied;
     }
    }
    string resultName=routerSelfTest?"self-test-router":"self-test";
    using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,resultName+".png")))await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
    bool passed=checks.Values.All(v=>v);File.WriteAllText(Path.Combine(data,"self-test.marker"),"test profile");File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,resultName+".json"),json.Serialize(new{passed,checks,url=browser.Source.AbsoluteUri}));Environment.ExitCode=passed?0:1;Close();
   }catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test-error.txt"),ex.ToString());Environment.Exit(1);}
  }
  bool IsHub(Uri u){return u!=null&&u.Scheme=="https"&&u.Host=="freeisp-desk.local"&&u.IsDefaultPort;}
  bool SameRouter(Uri u){return router!=null&&u.Scheme==router.Scheme&&u.Authority==router.Authority;}
  void ShowHub(){busy=false;controls.Visible=false;browser.CoreWebView2.Navigate(Hub);}
  Task Send(object message){if(IsHub(browser.Source))browser.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));return Task.CompletedTask;}
  List<RouterEntry> ReadRouters(){try{return json.Deserialize<List<RouterEntry>>(File.ReadAllText(Path.Combine(data,"routers.json")))??new List<RouterEntry>();}catch{return new List<RouterEntry>();}}
  public static Uri Address(string text){Uri u;text=(text??"").Trim();if(!text.Contains("://"))text="https://"+text;if(!Uri.TryCreate(text,UriKind.Absolute,out u)||(u.Scheme!="https"&&u.Scheme!="http")||string.IsNullOrEmpty(u.Host)||u.UserInfo.Length>0||u.Host=="freeisp-desk.local")throw new Exception("Enter a valid HTTP or HTTPS router address without credentials.");return new Uri(u.GetLeftPart(UriPartial.Authority));}
  async void HandleMessage(object sender,CoreWebView2WebMessageReceivedEventArgs args){
   Uri origin;if(!Uri.TryCreate(args.Source,UriKind.Absolute,out origin)||!IsHub(origin)||!IsHub(browser.Source))return;
   try{
    var m=json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
    string action=Convert.ToString(m["action"]);
    if(action=="discover"){await Discover();return;}
    if(action=="remove"){var list=ReadRouters();list.RemoveAll(r=>r.address==Convert.ToString(m["address"]));File.WriteAllText(Path.Combine(data,"routers.json"),json.Serialize(list));await Send(new{type="routers",routers=list});return;}
    if(action!="connect"||busy)return;
    var address=Address(Convert.ToString(m["address"]));var username=Convert.ToString(m["username"]);var password=Convert.ToString(m["password"]);
    if(string.IsNullOrWhiteSpace(username)||string.IsNullOrEmpty(password))throw new Exception("Enter your router username and password.");
    busy=true;await Send(new{type="status",message="Signing in…",busy=true});
    // Authenticate without following redirects so credentials can only reach the chosen origin.
    string cookie=await RouterConnection.Authenticate(address,username,password);password=null;
    string cookieName=address.Scheme=="https"?"sysauth_https":"sysauth_http";
    var session=browser.CoreWebView2.CookieManager.CreateCookie(cookieName,cookie,address.Host,"/cgi-bin/luci/");
      session.IsHttpOnly=true;session.IsSecure=address.Scheme=="https";session.SameSite=CoreWebView2CookieSameSiteKind.Strict;
      browser.CoreWebView2.CookieManager.AddOrUpdateCookie(session);
    if(m.ContainsKey("remember")&&Convert.ToBoolean(m["remember"])){
     var list=ReadRouters();list.RemoveAll(r=>r.address==address.AbsoluteUri);
     list.Add(new RouterEntry{name=string.IsNullOrWhiteSpace(Convert.ToString(m["name"]))?address.Host:Convert.ToString(m["name"]),address=address.AbsoluteUri,username=username,source="Saved"});
     File.WriteAllText(Path.Combine(data,"routers.json"),json.Serialize(list));
    }
    router=address;controls.Visible=true;browser.CoreWebView2.Navigate(new Uri(router,"/cgi-bin/luci/admin/freeisp").AbsoluteUri);
   }catch(Exception ex){await Send(new{type="status",message=ex is TaskCanceledException?"Connection timed out. Check the router or SSH tunnel.":ex is HttpRequestException?"Connection failed. Check the address, tunnel and HTTPS certificate.":ex.Message,busy=false});}finally{busy=false;}
  }
  public static bool Private(IPAddress ip){var b=ip.GetAddressBytes();return b.Length==4&&(b[0]==10||(b[0]==192&&b[1]==168)||(b[0]==172&&b[1]>=16&&b[1]<=31));}
  async Task Discover(){
   if(scanning)return;scanning=true;
   try{
    await Send(new{type="scan",busy=true,message="Checking local network gateways…"});
    var gateways=NetworkInterface.GetAllNetworkInterfaces().Where(n=>n.OperationalStatus==OperationalStatus.Up&&n.NetworkInterfaceType!=NetworkInterfaceType.Loopback).SelectMany(n=>n.GetIPProperties().GatewayAddresses).Select(g=>g.Address).Where(Private).Select(ip=>ip.ToString()).Distinct().Take(16).ToArray();
    var found=await Task.WhenAll(gateways.Select(async ip=>{
     using(var handler=new HttpClientHandler{AllowAutoRedirect=false,UseProxy=false})
     using(var client=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(3)}){
      foreach(var scheme in new[]{"https","http"})try{
       string url=scheme+"://"+ip;
       using(var response=await client.GetAsync(url+"/luci-static/freeisp/navigation.js",HttpCompletionOption.ResponseHeadersRead)){
        if(!response.IsSuccessStatusCode)continue;
        using(var stream=await response.Content.ReadAsStreamAsync()){
         var bytes=new byte[16384];var read=stream.ReadAsync(bytes,0,bytes.Length);
         if(await Task.WhenAny(read,Task.Delay(3000))!=read)continue;
         int count=await read;var text=Encoding.UTF8.GetString(bytes,0,count);
         if(text.Contains("FreeISP")&&text.Contains("freeisp-sidebar"))return new RouterEntry{name="FreeISP gateway",address=url,username="root",source="Local gateway"};
        }
       }
      }catch(HttpRequestException){}catch(TaskCanceledException){}
     }
     return null;
    }));
    await Send(new{type="discovered",routers=found.Where(r=>r!=null).ToArray(),message="Gateway discovery finished. Other routers can be added by address."});
   }catch(Exception){await Send(new{type="scan",busy=false,message="Discovery could not finish. You can still connect by address."});}finally{scanning=false;}
  }
 }
}
