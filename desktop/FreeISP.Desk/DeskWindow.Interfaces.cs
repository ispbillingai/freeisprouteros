using System;
using System.Collections.Generic;
using System.Threading.Tasks;
namespace FreeISP.Desk {
 internal sealed partial class DeskWindow {
  const string InterfacesPage="https://freeisp-desk.local/interfaces.html";
  RouterDataClient routerData;
  int interfaceGeneration,interfaceRequest;
  bool IsInterfaces(Uri uri){return IsHub(uri)&&uri.AbsolutePath=="/interfaces.html";}
  bool IsDeviceHub(Uri uri){return IsHub(uri)&&(uri.AbsolutePath=="/index.html"||uri.AbsolutePath=="/");}
  void CancelInterfaceRequests(){interfaceGeneration++;interfaceRequest=0;routerData?.Cancel();}
  void ShowInterfaces(){
   if(closing)return;CancelInterfaceRequests();navigationGeneration++;preparingNavigation=false;navigating=false;approvedNavigation=null;assetCache=null;bypassPageCache=false;
   browser.CoreWebView2.Stop();loading.Visible=false;browser.Visible=true;controls.BringToFront();connectionLabel.Text=router?.Authority??"No router connected";
   browser.CoreWebView2.Navigate(InterfacesPage);
  }
  Task SendInterfaceContext(){return Send(new{type="interfaceContext",router=router?.Authority??"",generation=interfaceGeneration});}
  async Task HandleInterfaceMessage(Dictionary<string,object> message){
   string action=Convert.ToString(message["action"]);
   if(action=="hub"){ShowHub();return;}
   if(action=="openRouterPage"){
    string route=message.ContainsKey("route")?Convert.ToString(message["route"]):"";
    var allowed=new[]{"freeisp","network/freeisp_interfaces","network/freeisp_bridge","network/freeisp_pppoe","network/freeisp_hotspot","network/freeisp_firewall","network/freeisp_queues","network/freeisp_tools","system/freeisp_files","status/freeisp_log","wifi/interfaces"};
    if(router!=null&&Array.IndexOf(allowed,route)>=0){CancelInterfaceRequests();await NavigateRouter(new Uri(router,"/cgi-bin/luci/admin/"+route));}
    return;
   }
   object supplied;if(action!="interfacesSnapshot"||!message.TryGetValue("generation",out supplied)||Convert.ToInt32(supplied)!=interfaceGeneration||interfaceRequest==interfaceGeneration)return;
   int generation=interfaceGeneration;var client=routerData;interfaceRequest=generation;
   try{
    if(client==null)throw new InvalidOperationException("Choose a router in Device Hub and sign in to see live data.");
    var sample=await client.Interfaces();
    if(!closing&&generation==interfaceGeneration&&ReferenceEquals(client,routerData)&&IsInterfaces(browser.Source))await Send(new{type="interfaceSnapshot",generation,sample});
   }catch(Exception ex){
    if(!closing&&generation==interfaceGeneration&&IsInterfaces(browser.Source))await Send(new{type="interfaceError",generation,message=ex is InvalidOperationException?ex.Message:"Connection unavailable. Live data will retry when the router responds."});
   }finally{if(interfaceRequest==generation)interfaceRequest=0;}
  }
 }
}
