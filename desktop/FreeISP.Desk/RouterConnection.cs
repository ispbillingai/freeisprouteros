using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace FreeISP.Desk {
 internal static class RouterConnection {
  internal static async Task<string> Authenticate(Uri address,string username,string password){
   using(var handler=new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false})
   using(var client=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(20)})
   using(var body=new FormUrlEncodedContent(new[]{new KeyValuePair<string,string>("luci_username",username),new KeyValuePair<string,string>("luci_password",password)}))
   using(var response=await client.PostAsync(new Uri(address,"/cgi-bin/luci/admin/freeisp"),body)){
    IEnumerable<string> headers;
    if((int)response.StatusCode!=302||!response.Headers.TryGetValues("Set-Cookie",out headers))throw new InvalidOperationException("Sign-in failed. Check the router address, username and password.");
    string name=address.Scheme=="https"?"sysauth_https":"sysauth_http";
    string cookie=headers.Select(h=>h.Split(';')[0]).FirstOrDefault(h=>h.StartsWith(name+"=",StringComparison.Ordinal));
    if(cookie==null||cookie.Length==name.Length+1)throw new InvalidOperationException("The router did not return a supported login session.");
    return cookie.Substring(name.Length+1);
   }
  }

  // Loopback-only fixtures exercise the same authentication path used by Connect.
  internal static async Task<Dictionary<string,bool>> SelfTest(){
   var checks=new Dictionary<string,bool>();
   foreach(var scenario in new[]{"success","invalid_credentials","empty_session","redirect"}){
    var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();
    int port=((IPEndPoint)listener.LocalEndpoint).Port;
    var server=Task.Run(async()=>{
     using(var socket=await listener.AcceptTcpClientAsync())using(var stream=socket.GetStream()){
      var reader=new StreamReader(stream,Encoding.ASCII,false,1024,true);string line;
      while(!string.IsNullOrEmpty(line=await reader.ReadLineAsync())){}
      string response=scenario=="invalid_credentials"?"HTTP/1.1 200 OK\r\n": "HTTP/1.1 302 Found\r\n";
      if(scenario=="success")response+="Set-Cookie: sysauth_http=0123456789abcdef0123456789abcdef; HttpOnly\r\n";
      if(scenario=="empty_session")response+="Set-Cookie: sysauth_http=; HttpOnly\r\n";
      if(scenario=="redirect")response+="Location: http://127.0.0.1:"+port+"/unexpected\r\n";
      byte[] bytes=Encoding.ASCII.GetBytes(response+"Content-Length: 0\r\nConnection: close\r\n\r\n");await stream.WriteAsync(bytes,0,bytes.Length);
     }
    });
    try{
     string cookie=await Authenticate(new Uri("http://127.0.0.1:"+port),"test","test-only");
     checks[scenario]=scenario=="success"&&cookie=="0123456789abcdef0123456789abcdef";
    }catch(InvalidOperationException){checks[scenario]=scenario!="success";}
    finally{listener.Stop();}
    await server;
   }
   var closed=new TcpListener(IPAddress.Loopback,0);closed.Start();int closedPort=((IPEndPoint)closed.LocalEndpoint).Port;closed.Stop();
   try{await Authenticate(new Uri("http://127.0.0.1:"+closedPort),"test","test-only");checks["connection_refused"]=false;}catch(HttpRequestException){checks["connection_refused"]=true;}
   return checks;
  }
 }
}
