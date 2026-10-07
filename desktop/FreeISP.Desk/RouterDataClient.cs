using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FreeISP.Desk {
 // Only this fixed, read-only operation is exposed to the bundled Interfaces page.
 internal sealed class RouterDataClient : IDisposable {
  readonly HttpClient client;
  readonly object operationLock=new object();
  readonly HashSet<CancellationTokenSource> operations=new HashSet<CancellationTokenSource>();
  readonly Uri endpoint;
  readonly string session;
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=2*1024*1024};
  internal RouterDataClient(Uri router,string session){
   if(router==null||(router.Scheme!="http"&&router.Scheme!="https")||router.UserInfo.Length!=0||string.IsNullOrEmpty(session))throw new ArgumentException("Router session is required.");
   this.session=session;endpoint=new Uri(router,"/ubus/");
   client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=TimeSpan.FromSeconds(5)};
  }
  internal void Cancel(){
   CancellationTokenSource[] pending;
   lock(operationLock){pending=new CancellationTokenSource[operations.Count];operations.CopyTo(pending);}
   foreach(var operation in pending){try{operation.Cancel();}catch(ObjectDisposedException){}}
   client.CancelPendingRequests();
  }
  internal async Task<object> Interfaces(){
   using(var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(5))){
   lock(operationLock)operations.Add(deadline);
   try{
   using(var body=new StringContent(json.Serialize(new{jsonrpc="2.0",id=1,method="call",@params=new object[]{session,"network.device","status",new{}}}),Encoding.UTF8,"application/json"))
   using(var request=new HttpRequestMessage(HttpMethod.Post,endpoint){Content=body})
   using(var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token)){
    if(!response.IsSuccessStatusCode)throw new InvalidOperationException("Router data is unavailable. Check the connection or sign in again.");
    byte[] bytes;
    using(var stream=await response.Content.ReadAsStreamAsync())
    using(deadline.Token.Register(()=>stream.Dispose())){
     var pending=RouterAssetCache.LimitedRead(stream,2*1024*1024);
     if(await Task.WhenAny(pending,Task.Delay(Timeout.Infinite,deadline.Token))!=pending)throw new TimeoutException("The router is taking too long to respond.");
     bytes=await pending;
    }
    if(bytes==null)throw new InvalidOperationException("Router response exceeded the supported size.");
    var reply=json.DeserializeObject(Encoding.UTF8.GetString(bytes)) as Dictionary<string,object>;
    object replyId,version;
    if(reply==null||!reply.TryGetValue("jsonrpc",out version)||!Equals(version,"2.0")||!reply.TryGetValue("id",out replyId)||!Equals(replyId,1))throw new InvalidOperationException("The router returned an unexpected response.");
    object rpcError;
    if(reply.TryGetValue("error",out rpcError)){
     var error=rpcError as Dictionary<string,object>;object errorCode;
     if(error!=null&&error.TryGetValue("code",out errorCode)&&Convert.ToInt32(errorCode)==-32002)throw new InvalidOperationException("Router session expired or access was denied. Sign in again.");
     throw new InvalidOperationException("The router could not read interface statistics.");
    }
    object value;var result=reply!=null&&reply.TryGetValue("result",out value)?value as object[]:null;
    if(result==null||result.Length<1)throw new InvalidOperationException("The router returned an unsupported data response.");
    int code=Convert.ToInt32(result[0]);
    if(code==6)throw new InvalidOperationException("Router session expired or access was denied. Sign in again.");
    if(code!=0||result.Length!=2)throw new InvalidOperationException("The router could not read interface statistics.");
    var devices=result[1] as Dictionary<string,object>;
    if(devices==null||devices.Count>512)throw new InvalidOperationException("The router returned invalid interface data.");
    var clean=new Dictionary<string,object>();
    foreach(var pair in devices){
     var row=pair.Value as Dictionary<string,object>;
     if(row==null||pair.Key.Length>64)continue;
     object statsValue;var stats=row.TryGetValue("statistics",out statsValue)?statsValue as Dictionary<string,object>:null;
     object upValue;object up=row.TryGetValue("up",out upValue)&&upValue is bool?upValue:null;
     object typeValue;string type=row.TryGetValue("type",out typeValue)?Convert.ToString(typeValue):"unknown";
     if(type.Length>64)type="unknown";
     clean[pair.Key]=new{up,mtu=Number(row,"mtu"),type,statistics=new{rx_bytes=Number(stats,"rx_bytes"),tx_bytes=Number(stats,"tx_bytes"),rx_packets=Number(stats,"rx_packets"),tx_packets=Number(stats,"tx_packets")}};
    }
    return new{schema=1,sampleTime=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),devices=clean};
   }
   }finally{lock(operationLock)operations.Remove(deadline);}
   }
  }
  static object Number(Dictionary<string,object> row,string name){object value;if(row==null||!row.TryGetValue(name,out value)||!(value is int||value is long||value is decimal||value is double))return null;double number=Convert.ToDouble(value);return double.IsNaN(number)||double.IsInfinity(number)||number<0?(object)null:number;}
  public void Dispose(){Cancel();client.Dispose();}
 }
}
