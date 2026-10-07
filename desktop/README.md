# FreeISP Desk for Windows — Device Hub

Version 0.3.1 preserves the full router sidebar in the local Interfaces view.
All sidebar routes remain available in the same order. Router menu navigation
reuses the loaded LuCI runtime instead of restarting the document, translations,
menu and common libraries on each click. The destination heading appears while
fresh settings arrive; data and configuration are not cached. PPPoE and Hotspot
render their complete tabs/table controls before their initial data request,
with writes disabled until that request succeeds.

The shared navigator checks fresh router HTML for the session, route permission
and read-only state, removes old polling and event callbacks, ignores late
renders, reloads UCI values, and preserves unsaved-change guards. Overview's
native template widgets are supported. A changed UI release causes a full
reload; public revision checks are reused for at most 30 seconds. The native
app keeps the router shell visible during normal navigation and retains bounded
recovery controls. Fresh values can still take seconds on the software-emulated
VPS; this release does not claim instantaneous router responses.

Version 0.3.0 opens a bundled Interfaces workspace after login. Its layout,
search, Day/Night themes, table and traffic chart are local, so rendering does
not wait for a router page or release-manifest download. The native app reads
interface counters from the authenticated router and updates the workspace
about once a second, with one request in flight. Rates require two readings.
Missing values stay unknown and disconnected readings are marked as stale.

The Interfaces toolbar button also opens the layout while disconnected.
Quick Set, PPPoE, Hotspot, Bridge/VLAN, Firewall, Queues and Tools remain
available through Router Settings shortcuts. Those configuration pages are
still served by the router; this release does not make every page local.

The data bridge only permits the fixed read-only network.device/status call.
The session remains in native memory, credentials never enter the Interfaces
page, redirects are rejected and HTTPS certificate validation stays enabled.
Responses have a five-second deadline and 2 MiB limit. Leaving the workspace,
refreshing or disconnecting cancels pending reads; old-router results cannot
populate a new connection. Existing encrypted saved passwords and the original
FreeISP window/taskbar icon are preserved.

Version 0.2.8 reuses the browser cache while the router and interface revision
are unchanged. Static requests during menu navigation wait for the revision
check so they can use local assets rather than racing ahead over the network.
Settings and API responses remain live.

Version 0.2.7 saves passwords when “Remember this router and password” is
selected after a successful login. Windows DPAPI protects each password for
the current Windows account, bound to the exact router address and username.
Only the native connection code decrypts it; the Hub receives a saved-password
flag, never the stored secret. Selecting a saved router allows Connect without
retyping. Editing its address or username requires entering the password again.
Forget removes the saved entry and encrypted password. Existing entries need
one successful login with Remember selected to store their password.

Version 0.2.6 keeps WebView visible beneath the opaque loading panel. Hiding
the control pauses animation-frame callbacks used by LuCI and could prevent
the page from ever becoming ready. The regression fixture now renders through
requestAnimationFrame; the old executable fails it and the fix passes.
A loopback-only live test also signs in through Device Hub and verifies that
the deployed router's Quick Set renders without changing its configuration.

Version 0.2.5 waits for the router view to render instead of revealing an
unfinished loading page after six seconds. A 30-second deadline covers both
the document request and the subsequent view rendering. A timeout keeps the
local Retry and Device Hub controls visible. Retry opens the same page and
fetches fresh static files for that navigation, retaining the login cookie;
later navigations use the repaired cache normally. It never automatically
resubmits a settings form. Old navigation callbacks cannot replace a newer
page or the Device Hub, and closing the window cancels readiness work.

Configuration pages still use LuCI's router HTML and live API calls. This is
not a complete local, data-only management client. Static JavaScript, CSS,
images and fonts can now be reused locally after their first network load.
Before connection/refresh, and during internal navigation, Desk checks the
router's `/luci-static/freeisp/release.json`. Its `revision` must be a 40–64
character hexadecimal content hash. The release process must change that hash
whenever presentation assets or their backend contract changes.

Caches are separate for each exact scheme, host and port, and each revision.
Changed revisions invalidate old assets automatically. Missing, invalid or
unreachable manifests bypass the custom cache. HTML, authentication, RPC and
configuration are never cached by this layer; router actions require a live
connection. Native page POSTs retain their method and body. HTTPS certificate
validation remains enabled. Assets are limited to 2 MiB each, 128 objects and
16 MiB per router; only the current revision is retained. Disconnect clears
WebView session data, while public presentation assets can remain on disk.

## Run

Download and run the single FreeISP Desk.exe on 64-bit Windows. The Device Hub,
original FreeISP logo and browser loader libraries are embedded in the executable
and unpack automatically into the current user’s local application-data folder.
No ZIP or separate Hub folder is required. Windows must have .NET Framework 4.8
and Microsoft Edge WebView2 Runtime installed. The hub itself opens offline.

Startup navigates explicitly to the bundled index.html, never the virtual folder
root. Version 0.2 used the folder root, which produced ERR_ACCESS_DENIED.

For the VPS lab, keep the SSH tunnel running and use http://127.0.0.1:8874.
Enter the router credentials, not the VPS SSH credentials. For hardware, enter
its HTTPS address. No passwords are embedded in the application.

Remember this router and password saves its name, address and username, plus
a password encrypted for this Windows account. Browser sessions remain until logout,
disconnect, expiry or clearing the app profile. Device Hub returns to the local
connection screen; Disconnect clears browser data. Use the router's Logout to
terminate its server session.

Discovery checks private IPv4 gateway addresses from active network adapters
for the FreeISP interface. It does not scan the entire subnet, discover remote
VPS routers, authenticate device identity, or implement WinBox/MAC discovery.
Routers elsewhere on the LAN can be added manually. Discovery results are
untrusted hints; HTTPS certificate checks remain enabled when connecting.

## Build

    dotnet restore desktop/FreeISP.Desk/FreeISP.Desk.csproj --source https://api.nuget.org/v3/index.json
    dotnet build desktop/FreeISP.Desk/FreeISP.Desk.csproj -c Release --no-restore -o artifacts/releases/freeisp-desk-v0.3.1

Local data: %LOCALAPPDATA%\FreeISP\Desk. The connection-screen files are under
Hub and are also usable as a static design preview; login and discovery require
the Windows host. Messages from router pages cannot invoke host actions.
Credentials are posted only to the chosen router origin without following
redirects; the returned session cookie is installed in the embedded browser.

No automatic executable updater is included. Compatible router interface
updates refresh automatically when navigating or using Refresh; native client
changes require downloading the new single executable. A fully bundled local
management client needs a separately versioned API contract and implementations
of all management views. The current cache does not claim that architecture.

The original logo is copied unchanged from the user-provided F:/Logos/logo.png.
Run the built executable with --self-test to verify embedded extraction and hub
rendering with external WebView requests blocked. Test files are written beside
the executable; no router credentials or live connection are used by this check.
The test also verifies the explicit Windows identity, local shell and cache
origin/type/size/revision guards. Run the real WebView cache fixture on Windows:

    python tools/desktop/test_cache.py "artifacts/releases/freeisp-desk-v0.3.1/FreeISP Desk.exe" --output artifacts/tests/cache-browser

This serves only a loopback fixture and runs a hidden, isolated application
profile. It verifies first network load, local asset reuse, revision refresh,
invalid-manifest bypass, uncached API reads and intact router form POSTs.
The readiness fixture deliberately serves a stuck view and cached broken
script, then repairs that script without changing the revision. It verifies
timeout recovery, a network retry, retained cookies, subsequent cache reuse,
and returning to the local hub during stuck rendering and document loading:

    python tools/desktop/test_readiness.py "artifacts/releases/freeisp-desk-v0.3.1/FreeISP Desk.exe" --output artifacts/tests/readiness-browser

The readiness test uses a shorter deadline in an isolated loopback-only
test profile; normal operation uses 30 seconds. These fixtures do not test
the availability of a deployed router's backend services.
It is not evidence of compatibility with every router page or of offline
router operation. The Windows icon may need an old pinned shortcut to be
unpinned and the new executable pinned again if Explorer retained its old icon.

The connection self-test also uses disposable loopback HTTP fixtures. Run
`--self-test` twice from the same test folder to verify saved-router and theme
persistence across process launches. With the disposable Tools VM on loopback
port 18940, `--self-test --tools-router-test` checks real router login, the native
Router Tools button and ping. These tests do not use a production router.

Local Interfaces checks:

    node tools/desktop/test_local_interfaces.cjs
    python tools/desktop/test_router_data.py "artifacts/releases/freeisp-desk-v0.3.1/FreeISP Desk.exe"

The browser fixture covers immediate layout, themes, unknown/stale data, rates,
chart rendering, non-overlapping polling and connection changes. The native
transport fixture covers the exact RPC contract, session failures, redirects,
invalid/oversized responses, timeouts and cancellation. With an authorized
router forwarded to loopback, `--live-router-test --test-router=http://127.0.0.1:8874`
uses the temporary `FREEISP_TEST_PASSWORD` environment variable to verify login,
real counters/rates, offline layout and saved-password reconnect. Test profiles
are isolated; the test does not change router configuration.

Shared menu lifecycle regression: `node tools/openwrt/test-fast-navigation.cjs`.
