using System;
using System.Security.Cryptography;
using System.Text;
namespace FreeISP.Desk {
 internal static class LocalPassword {
  static byte[] Context(string address,string username){return Encoding.UTF8.GetBytes("FreeISP.Desk/password/v1\n"+address+"\n"+username);}
  internal static string Seal(string password,string address,string username){
   byte[] value=Encoding.UTF8.GetBytes(password);
   try{return Convert.ToBase64String(ProtectedData.Protect(value,Context(address,username),DataProtectionScope.CurrentUser));}
   finally{Array.Clear(value,0,value.Length);}
  }
  internal static string Open(string saved,string address,string username){
   if(string.IsNullOrEmpty(saved))return null;
   byte[] value=null;
   try{value=ProtectedData.Unprotect(Convert.FromBase64String(saved),Context(address,username),DataProtectionScope.CurrentUser);return Encoding.UTF8.GetString(value);}
   catch(CryptographicException){throw new InvalidOperationException("Saved password is unavailable on this Windows account. Enter it again and remember this router.");}
   catch(FormatException){throw new InvalidOperationException("Saved password could not be read. Enter it again and remember this router.");}
   finally{if(value!=null)Array.Clear(value,0,value.Length);}
  }
  internal static bool SelfTest(){
   var saved=Seal("test-secret","https://router.invalid/","root");
   if(Open(saved,"https://router.invalid/","root")!="test-secret"||saved.Contains("test-secret"))return false;
   foreach(var pair in new[]{new[]{"https://other.invalid/","root"},new[]{"https://router.invalid/","other"}}){try{Open(saved,pair[0],pair[1]);return false;}catch(InvalidOperationException){}}
   try{Open("corrupt","https://router.invalid/","root");return false;}catch(InvalidOperationException){}
   return Open(null,"https://router.invalid/","root")==null;
  }
 }
}
