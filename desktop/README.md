# FreeISP Desk for Windows — Device Hub

Version 0.2.1 replaces the blank opening screen with the FreeISP Device Hub,
including Day/Night themes, direct router login, saved router cards and local
IPv4 gateway discovery. The router still serves the management pages.

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

Remember this router saves its name, address and username on this Windows
account. Passwords are not saved. Browser sessions remain until logout,
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
    dotnet build desktop/FreeISP.Desk/FreeISP.Desk.csproj -c Release --no-restore -o artifacts/releases/freeisp-desk-v0.2.1

Local data: %LOCALAPPDATA%\FreeISP\Desk. The connection-screen files are under
Hub and are also usable as a static design preview; login and discovery require
the Windows host. Messages from router pages cannot invoke host actions.
Credentials are posted only to the chosen router origin without following
redirects; the returned session cookie is installed in the embedded browser.

No automatic application updater is included. Router-served interface updates
appear after Reload; native client changes require replacing the app folder.

The original logo is copied unchanged from the user-provided F:/Logos/logo.png.
Run the built executable with --self-test to verify embedded extraction and hub
rendering with external WebView requests blocked. Test files are written beside
the executable; no router credentials or live connection are used by this check.
