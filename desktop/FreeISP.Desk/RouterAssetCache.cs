using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FreeISP.Desk {
 // Only public presentation assets are cached. HTML, RPC, sessions and
 // configuration are always handled by the connected router and WebView.
 internal sealed class RouterAssetCache {
  internal const int MaximumAssetBytes = 2 * 1024 * 1024;
  const long MaximumOriginBytes = 16 * 1024 * 1024;
  readonly string storage;
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  internal string Revision { get; private set; }
  internal Uri Origin { get; private set; }
  internal string Folder { get; private set; }
  internal RouterAssetCache(string storage) { this.storage = storage; }
  internal static string Hash(string value) { using (var sha = SHA256.Create()) return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(value)).Select(b => b.ToString("x2"))); }
  internal static bool Allowed(Uri origin, Uri uri) {
   if (origin == null || uri == null || origin.Scheme != uri.Scheme || origin.Authority != uri.Authority || uri.UserInfo.Length != 0) return false;
   string path = uri.AbsolutePath;
   if (!path.StartsWith("/luci-static/", StringComparison.Ordinal) || path.Contains("%") || path.Contains("\\")) return false;
   return new[] { ".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2" }.Contains(Path.GetExtension(path).ToLowerInvariant());
  }
  internal async Task Prepare(Uri origin) {
   Origin = origin; Revision = null; Folder = null;
   using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
   using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(4) }) {
    try {
     using (var request = new HttpRequestMessage(HttpMethod.Get, new Uri(origin, "/luci-static/freeisp/release.json?desk=" + DateTime.UtcNow.Ticks))) {
      request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true, NoStore = true };
      using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead)) {
       if (!response.IsSuccessStatusCode) return;
       using (var stream = await response.Content.ReadAsStreamAsync()) {
        var pending = LimitedRead(stream, 4096);
        if (await Task.WhenAny(pending, Task.Delay(4000)) != pending) return;
        byte[] bytes = await pending;
        if (bytes == null) return;
        var manifest = json.Deserialize<Release>(Encoding.UTF8.GetString(bytes));
        if (manifest == null || !Regex.IsMatch(manifest.revision ?? "", "^[a-fA-F0-9]{40,64}$")) return;
        Activate(origin, manifest.revision.ToLowerInvariant());
       }
      }
     }
    } catch (HttpRequestException) { } catch (TaskCanceledException) { } catch (IOException) { } catch (ArgumentException) { } catch (InvalidOperationException) { } catch (UnauthorizedAccessException) { }
   }
  }
  internal void Activate(Uri origin, string revision) {
   Origin = origin;
   string folder = Path.Combine(storage, Hash(origin.GetLeftPart(UriPartial.Authority)));
   Directory.CreateDirectory(folder);
   string marker = Path.Combine(folder, "revision.txt");
   if (!File.Exists(marker) || File.ReadAllText(marker) != revision) {
    // Generated hash filenames in one dedicated directory; no recursive deletion.
    foreach (string file in Directory.GetFiles(folder)) File.Delete(file);
    File.WriteAllText(marker, revision);
   }
   Folder = folder; Revision = revision;
  }
  string Key(Uri uri) { return Path.Combine(Folder, Hash(Revision + "\n" + uri.AbsoluteUri)); }
  internal bool TryRead(Uri uri, out byte[] body, out string contentType) {
   body = null; contentType = null;
   if (Revision == null || !Allowed(Origin, uri)) return false;
   try {
    string key = Key(uri);
    if (!File.Exists(key + ".type") || !File.Exists(key + ".body") || new FileInfo(key + ".body").Length > MaximumAssetBytes) return false;
    contentType = File.ReadAllText(key + ".type");
    if (!ValidType(uri, contentType)) return false;
    body = File.ReadAllBytes(key + ".body"); return true;
   } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
  }
  static bool ValidType(Uri uri, string type) {
   if (string.IsNullOrEmpty(type) || type.Length > 150 || type.Contains("\r") || type.Contains("\n")) return false;
   string mime = type.Split(';')[0].Trim().ToLowerInvariant(), ext = Path.GetExtension(uri.AbsolutePath).ToLowerInvariant();
   if (ext == ".js") return new[] {"application/javascript", "text/javascript", "application/x-javascript"}.Contains(mime);
   if (ext == ".css") return mime == "text/css";
   if (ext == ".woff" || ext == ".woff2") return mime.StartsWith("font/") || mime == "application/font-woff";
   return mime.StartsWith("image/");
  }
  internal void Store(Uri uri, string type, byte[] body) {
   if (Revision == null || !Allowed(Origin, uri) || body == null || body.Length > MaximumAssetBytes || !ValidType(uri, type)) return;
   try {
    var files = new DirectoryInfo(Folder).GetFiles("*.body").OrderBy(f => f.LastWriteTimeUtc).ToList();
    long total = files.Sum(f => f.Length); int count = files.Count;
    foreach (var file in files) {
     if (total + body.Length <= MaximumOriginBytes && count < 128) break;
     total -= file.Length; count--; file.Delete(); string meta = Path.ChangeExtension(file.FullName, ".type"); if (File.Exists(meta)) File.Delete(meta);
    }
    string key = Key(uri); File.WriteAllBytes(key + ".body", body); File.WriteAllText(key + ".type", type);
   } catch (IOException) { } catch (UnauthorizedAccessException) { }
  }
  internal static async Task<byte[]> LimitedRead(Stream input, int maximum) {
   using (var output = new MemoryStream()) {
    byte[] buffer = new byte[8192]; int count;
    while ((count = await input.ReadAsync(buffer, 0, Math.Min(buffer.Length, maximum + 1 - (int)output.Length))) > 0) {
     output.Write(buffer, 0, count); if (output.Length > maximum) return null;
    }
    return output.ToArray();
   }
  }
  internal static bool SelfTest(string root) {
   var a = new Uri("https://router-one.invalid"); var b = new Uri("https://router-two.invalid");
   var js = new Uri(a, "/luci-static/resources/view/freeisp/quickset.js?v=1");
   var cache = new RouterAssetCache(root); cache.Activate(a, new string('a', 64));
   cache.Store(js, "application/javascript", Encoding.UTF8.GetBytes("test asset"));
   byte[] body; string type;
   if (!cache.TryRead(js, out body, out type) || Encoding.UTF8.GetString(body) != "test asset") return false;
   if (Allowed(a, new Uri(a, "/cgi-bin/luci/admin/freeisp")) || Allowed(a, new Uri(a, "/ubus")) || Allowed(a, new Uri(b, js.PathAndQuery)) || Allowed(a, new Uri("http://router-one.invalid" + js.PathAndQuery))) return false;
   cache.Activate(a, new string('b', 64)); if (cache.TryRead(js, out body, out type)) return false;
   cache.Store(js, "text/html", Encoding.UTF8.GetBytes("login")); if (cache.TryRead(js, out body, out type)) return false;
   cache.Store(js, "application/javascript", new byte[MaximumAssetBytes + 1]); if (cache.TryRead(js, out body, out type)) return false;
   return true;
  }
  public sealed class Release { public string revision { get; set; } }
 }
}
