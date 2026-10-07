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
  internal const string AppIdentity="FreeISP.Desk";
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
  [DllImport("shell32.dll")] static extern int GetCurrentProcessExplicitAppUserModelID(out IntPtr appId);
  internal static string Identity(){IntPtr value;Marshal.ThrowExceptionForHR(GetCurrentProcessExplicitAppUserModelID(out value));try{return Marshal.PtrToStringUni(value);}finally{Marshal.FreeCoTaskMem(value);}}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetDllDirectory(string path);
  [STAThread] static void Main(){
   try{
    Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(AppIdentity));
    var assembly=Assembly.GetExecutingAssembly();
    Assets=Path.Combine(Environment.GetCommandLineArgs().Any(a=>a=="--self-test"||a=="--cache-test")?AppDomain.CurrentDomain.BaseDirectory:Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FreeISP","Desk","Components",assembly.ManifestModule.ModuleVersionId.ToString("N"));
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
  readonly WebView2 browser=new WebView2{Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(243,248,251)};
  readonly JavaScriptSerializer json=new JavaScriptSerializer();
  readonly string data=Path.Combine(Environment.GetCommandLineArgs().Any(a=>a=="--self-test"||a=="--cache-test")?AppDomain.CurrentDomain.BaseDirectory:Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FreeISP","Desk");
  readonly Panel controls=new Panel{Dock=DockStyle.Top,Height=52,BackColor=Color.FromArgb(11,36,53)};
  readonly Panel loading=new Panel{Dock=DockStyle.Fill,BackColor=Color.FromArgb(243,248,251)};
  readonly Label progressTitle=new Label{AutoSize=false,TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Segoe UI",21,FontStyle.Bold),ForeColor=Color.FromArgb(11,36,53),Text="Opening your workspace"};
  readonly Label progressDetail=new Label{AutoSize=false,TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Segoe UI",11),ForeColor=Color.FromArgb(82,108,128),Text="FreeISP Desk is ready on this computer."};
  readonly Label connectionLabel=new Label{AutoSize=true,ForeColor=Color.FromArgb(164,220,223),Top=19,Left=520,Text="Local workspace"};
  readonly Button retry=new Button{Text="Try again",Width=110,Height=32,Visible=false};
  readonly Button returnHub=new Button{Text="Device Hub",Width=110,Height=32,Visible=false};
  RouterAssetCache assetCache; string approvedNavigation; int navigationGeneration; bool preparingNavigation; bool navigating;
  Uri router; bool busy; bool scanning;
  readonly bool cacheTest=Environment.GetCommandLineArgs().Contains("--cache-test");
  readonly bool selfTest=Environment.GetCommandLineArgs().Contains("--self-test")||Environment.GetCommandLineArgs().Contains("--cache-test");
  int cacheTestStage;
  public DeskWindow(){
   Text="FreeISP Desk";Size=new Size(1320,900);MinimumSize=new Size(960,650);StartPosition=FormStartPosition.CenterScreen;
   Icon=new Icon(Path.Combine(Program.Assets,"freeisp.ico"));ShowIcon=true;
   if(selfTest){ShowInTaskbar=false;Opacity=0;var timer=new Timer{Interval=45000};timer.Tick+=(s,e)=>{File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test.json"),"{\"passed\":false,\"error\":\"timeout\"}");Environment.Exit(1);};timer.Start();}
   var brand=new PictureBox{Left=12,Top=7,Width=38,Height=38,SizeMode=PictureBoxSizeMode.Zoom,Image=Image.FromFile(Path.Combine(Program.Assets,"Hub","freeisp-logo.png"))};
   var title=new Label{Text="FreeISP Desk",ForeColor=Color.White,Font=new Font("Segoe UI",11,FontStyle.Bold),AutoSize=true,Left=59,Top=16};
   var home=ShellButton("Device Hub",185,100);home.Click+=(s,e)=>{if(browser.CoreWebView2!=null)ShowHub();};
   var reload=ShellButton("Refresh",295,90);reload.Click+=async(s,e)=>{if(browser.CoreWebView2!=null){if(router!=null&&!IsHub(browser.Source))await NavigateRouter(browser.Source);else ShowHub();}};
   var logout=ShellButton("Disconnect",395,110);logout.Click+=async(s,e)=>{if(browser.CoreWebView2==null)return;navigationGeneration++;router=null;assetCache=null;browser.CoreWebView2.Stop();await browser.CoreWebView2.Profile.ClearBrowsingDataAsync();ShowHub();};
   controls.Controls.AddRange(new Control[]{brand,title,home,reload,logout,connectionLabel});
   var largeLogo=new PictureBox{Width=130,Height=130,SizeMode=PictureBoxSizeMode.Zoom,Image=brand.Image};
   loading.Controls.AddRange(new Control[]{largeLogo,progressTitle,progressDetail,retry,returnHub});
   loading.Resize+=(s,e)=>{int middle=loading.ClientSize.Height/2;largeLogo.Left=(loading.Width-130)/2;largeLogo.Top=middle-160;progressTitle.SetBounds(20,middle-18,loading.Width-40,55);progressDetail.SetBounds(30,middle+45,loading.Width-60,60);retry.Left=loading.Width/2-115;retry.Top=middle+125;returnHub.Left=loading.Width/2+5;returnHub.Top=middle+125;};
   retry.Click+=async(s,e)=>{if(router!=null)await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp"));else ShowHub();};returnHub.Click+=(s,e)=>ShowHub();
   Controls.Add(browser);Controls.Add(loading);Controls.Add(controls);loading.BringToFront();controls.BringToFront();
   Shown+=async(s,e)=>{try{
    Directory.CreateDirectory(data);
    await browser.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(null,Path.Combine(data,"Browser")));
    var core=browser.CoreWebView2;
    core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
    core.WebResourceRequested+=(sender,args)=>{Uri uri;byte[] bytes;string type;var cache=assetCache;if(args.Request.Method!="GET"||!Uri.TryCreate(args.Request.Uri,UriKind.Absolute,out uri)||!RouterAssetCache.Allowed(router,uri))return;args.Request.Headers.SetHeader("Cache-Control","no-cache");if(cache==null||cache.Revision==null)return;args.Request.Headers.SetHeader("X-FreeISP-Desk-Revision",cache.Revision);if(cache.TryRead(uri,out bytes,out type))args.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(bytes),200,"OK","Content-Type: "+type+"\r\nCache-Control: no-store\r\nX-FreeISP-Desk-Cache: local\r\n");};
    core.WebResourceResponseReceived+=async(sender,args)=>{var cache=assetCache;Uri uri;if(cache==null||cache.Revision==null||args.Request.Method!="GET"||!Uri.TryCreate(args.Request.Uri,UriKind.Absolute,out uri)||!RouterAssetCache.Allowed(cache.Origin,uri)||args.Response.StatusCode!=200)return;try{if(args.Response.Headers.Contains("X-FreeISP-Desk-Cache")||!args.Request.Headers.Contains("X-FreeISP-Desk-Revision")||args.Request.Headers.GetHeader("X-FreeISP-Desk-Revision")!=cache.Revision)return;string type=args.Response.Headers.GetHeader("Content-Type");using(var stream=await args.Response.GetContentAsync()){if(stream==null)return;var pending=RouterAssetCache.LimitedRead(stream,RouterAssetCache.MaximumAssetBytes);if(await Task.WhenAny(pending,Task.Delay(5000))!=pending)return;var bytes=await pending;if(ReferenceEquals(cache,assetCache))cache.Store(uri,type,bytes);}}catch(Exception ex)when(ex is IOException||ex is ArgumentException||ex is InvalidOperationException||ex is COMException){}};
    if(selfTest){core.WebResourceRequested+=(resourceSender,resourceEvent)=>{Uri u;if(!Uri.TryCreate(resourceEvent.Request.Uri,UriKind.Absolute,out u)||(!IsHub(u)&&!(cacheTest&&SameRouter(u))))resourceEvent.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(),503,"Offline test","");};}
    string hubFolder=Path.Combine(Program.Assets,"Hub");
    foreach(string file in new[]{"index.html","hub.css","hub.js"})
     if(!File.Exists(Path.Combine(hubFolder,file)))throw new FileNotFoundException("A bundled app file is missing. Download FreeISP Desk again. Missing: Hub/"+file);
    core.SetVirtualHostNameToFolderMapping("freeisp-desk.local",hubFolder,CoreWebView2HostResourceAccessKind.DenyCors);
    core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
    core.WebMessageReceived+=HandleMessage;
    core.NavigationStarting+=async(sender,args)=>{Uri target;if(!Uri.TryCreate(args.Uri,UriKind.Absolute,out target)||(!IsHub(target)&&!SameRouter(target))){args.Cancel=true;return;}navigating=true;if(IsHub(target))return;if(approvedNavigation==target.AbsoluteUri){approvedNavigation=null;return;}int generation=++navigationGeneration;assetCache=null;ShowProgress("Your network workspace","Reading the latest router settings…");var next=new RouterAssetCache(Path.Combine(data,"RouterAssets"));await next.Prepare(router);if(generation==navigationGeneration&&SameRouter(target))assetCache=next;};
    core.NewWindowRequested+=(sender,args)=>args.Handled=true;
    core.NavigationCompleted+=async(sender,args)=>{
     if(!navigating||preparingNavigation)return;navigating=false;
     if(!args.IsSuccess||args.HttpStatusCode>=400){if(!args.IsSuccess&&args.WebErrorStatus==CoreWebView2WebErrorStatus.OperationCanceled)return;ShowProgress("Connection unavailable",IsHub(browser.Source)?"The bundled workspace could not open. Reopen FreeISP Desk.":"Check the router address or SSH tunnel, then try again. Your local workspace is still available.",true);return;}
     if(cacheTest&&!IsHub(browser.Source)){await CheckBrowserCache();return;}
     if(!IsHub(browser.Source)){int generation=navigationGeneration;for(int attempt=0;attempt<60;attempt++){if(generation!=navigationGeneration)return;string ready=await core.ExecuteScriptAsync("!document.querySelector('#view') || !!document.querySelector('#view h2, #view .cbi-map, #view table, input[name=luci_password]')");if(ready=="true")break;await Task.Delay(100);}}
     loading.Visible=false;browser.Visible=true;connectionLabel.Text=IsHub(browser.Source)?"Local workspace":router?.Authority;
     if(IsHub(browser.Source)){if(selfTest){await Task.Delay(400);string result=await core.ExecuteScriptAsync("JSON.stringify({passed:!!document.querySelector('#connection') && !!document.querySelector('#scan') && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',url:location.href,bridge:!!window.chrome.webview,logo:document.querySelector('.original-logo').naturalWidth>0})");var report=json.Deserialize<Dictionary<string,object>>(json.Deserialize<string>(result));report["assetCacheTests"]=RouterAssetCache.SelfTest(Path.Combine(data,"SelfTestCache"));report["appIdentity"]=Program.Identity();report["originalIcon"]=Icon!=null;report["localShell"]=controls.Visible;report["passed"]=Convert.ToBoolean(report["passed"])&&Convert.ToBoolean(report["assetCacheTests"])&&Program.Identity()==Program.AppIdentity;File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test.json"),json.Serialize(report));using(var image=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test.png")))await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);Close();return;}await Send(new{type="routers",routers=ReadRouters()});}
    };
    if(cacheTest){var argument=Environment.GetCommandLineArgs().FirstOrDefault(a=>a.StartsWith("--test-router="));router=Address(argument?.Substring("--test-router=".Length));if(!router.IsLoopback)throw new Exception("Cache tests require a loopback fixture.");await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp"));}else ShowHub();
   }catch(Exception ex){if(selfTest){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"self-test-error.txt"),ex.ToString());Environment.Exit(1);}ShowProgress("Workspace could not open","Microsoft Edge WebView2 Runtime is required. "+ex.Message,true);}};
  }
  bool IsHub(Uri u){return u!=null&&u.Scheme=="https"&&u.Host=="freeisp-desk.local"&&u.IsDefaultPort;}
  async Task CheckBrowserCache(){
   try{
    await Task.Delay(400);
    string version=json.Deserialize<string>(await browser.CoreWebView2.ExecuteScriptAsync("window.assetVersion"));
    using(var client=new HttpClient()){
     var stats=json.Deserialize<Dictionary<string,object>>(await client.GetStringAsync(new Uri(router,"/fixture/stats")));
     int[] expectedAssets={1,1,2,3,4};string[] expectedVersions={"A","A","B","C","C"};
     if(version!=expectedVersions[cacheTestStage]||Convert.ToInt32(stats["assets"])!=expectedAssets[cacheTestStage]||Convert.ToInt32(stats["api"])!=cacheTestStage+1)throw new Exception("Cache/browser contract failed at stage "+cacheTestStage+": "+json.Serialize(stats)+" version="+version);
     if(cacheTestStage==4){if(!Convert.ToBoolean(stats["postIntact"]))throw new Exception("Router form POST body was not preserved.");File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"cache-test.json"),json.Serialize(new{passed=true,firstNetworkLoad=true,sameRevisionLocalAsset=true,revisionRefresh=true,missingManifestBypass=true,apiNeverCached=true,formPostPreserved=true,stats=stats}));Close();return;}
     cacheTestStage++;
     if(cacheTestStage==2||cacheTestStage==3)await client.GetStringAsync(new Uri(router,"/fixture/revision?stage="+cacheTestStage));
    }
    if(cacheTestStage==4)await browser.CoreWebView2.ExecuteScriptAsync("var form=document.createElement('form');form.method='POST';form.action='/cgi-bin/luci/admin/freeisp';var input=document.createElement('input');input.name='probe';input.value='preserved';form.appendChild(input);document.body.appendChild(form);form.submit();");else await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp?page="+cacheTestStage));
   }catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"cache-test.json"),json.Serialize(new{passed=false,error=ex.ToString()}));Close();}
  }
  bool SameRouter(Uri u){return router!=null&&u.Scheme==router.Scheme&&u.Authority==router.Authority;}
  Button ShellButton(string text,int left,int width){return new Button{Text=text,Left=left,Top=10,Width=width,Height=32,FlatStyle=FlatStyle.Flat,ForeColor=Color.White,BackColor=Color.FromArgb(24,62,80),Font=new Font("Segoe UI",9)};}
  void ShowProgress(string title,string detail,bool failed=false){progressTitle.Text=title;progressDetail.Text=detail;retry.Visible=returnHub.Visible=failed&&browser.CoreWebView2!=null;loading.Visible=true;loading.BringToFront();controls.BringToFront();browser.Visible=false;}
  async Task NavigateRouter(Uri target){
   if(target==null||!SameRouter(target))return;int generation=++navigationGeneration;preparingNavigation=true;assetCache=null;browser.CoreWebView2.Stop();ShowProgress("Your network workspace","Connecting to "+router.Authority+". Checking the latest interface…");
   try{
    var next=new RouterAssetCache(Path.Combine(data,"RouterAssets"));await next.Prepare(router);
    if(generation!=navigationGeneration||!SameRouter(target))return;
    // Do not let WebView's independent HTTP cache retain a previous UI revision.
    await browser.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
    if(generation!=navigationGeneration||!SameRouter(target))return;
    assetCache=next;approvedNavigation=target.AbsoluteUri;preparingNavigation=false;browser.CoreWebView2.Navigate(target.AbsoluteUri);
   }catch(Exception ex){if(generation==navigationGeneration){preparingNavigation=false;ShowProgress("Connection unavailable","Your local workspace is ready. "+ex.Message,true);}}
  }
  void ShowHub(){navigationGeneration++;preparingNavigation=false;approvedNavigation=null;assetCache=null;busy=false;browser.CoreWebView2.Stop();ShowProgress("Your local workspace","Opening saved routers and connection tools…");browser.CoreWebView2.Navigate(Hub);}
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
    using(var handler=new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false})
    using(var client=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(20)}){
     var url=new Uri(address,"/cgi-bin/luci/admin/freeisp");
     using(var body=new FormUrlEncodedContent(new[]{new KeyValuePair<string,string>("luci_username",username),new KeyValuePair<string,string>("luci_password",password)}))
     using(var response=await client.PostAsync(url,body)){
      password=null;IEnumerable<string> headers;
      if((int)response.StatusCode!=302||!response.Headers.TryGetValues("Set-Cookie",out headers))throw new Exception("Sign-in failed. Check the router address, username and password.");
      string cookieName=address.Scheme=="https"?"sysauth_https":"sysauth_http";
      string cookie=headers.Select(h=>h.Split(';')[0]).FirstOrDefault(h=>h.StartsWith(cookieName+"=",StringComparison.Ordinal));
      if(cookie==null)throw new Exception("The router did not return a supported login session.");
      var session=browser.CoreWebView2.CookieManager.CreateCookie(cookieName,cookie.Substring(cookieName.Length+1),address.Host,"/cgi-bin/luci/");
      session.IsHttpOnly=true;session.IsSecure=address.Scheme=="https";session.SameSite=CoreWebView2CookieSameSiteKind.Strict;
      browser.CoreWebView2.CookieManager.AddOrUpdateCookie(session);
     }
    }
    if(m.ContainsKey("remember")&&Convert.ToBoolean(m["remember"])){
     var list=ReadRouters();list.RemoveAll(r=>r.address==address.AbsoluteUri);
     list.Add(new RouterEntry{name=string.IsNullOrWhiteSpace(Convert.ToString(m["name"]))?address.Host:Convert.ToString(m["name"]),address=address.AbsoluteUri,username=username,source="Saved"});
     File.WriteAllText(Path.Combine(data,"routers.json"),json.Serialize(list));
    }
    router=address;await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/freeisp"));
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
