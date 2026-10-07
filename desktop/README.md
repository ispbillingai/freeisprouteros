# FreeISP Desk for Windows

The first Windows client embeds the router's LuCI interface using Microsoft
WebView2. Quick Set and other pages come from the connected router, so browser
and desktop changes stay synchronized. This is an HTTP/HTTPS router manager;
MikroTik WinBox protocol, MAC discovery and saved router profiles are not included.

Build with a .NET SDK and NuGet access:

    dotnet restore desktop/FreeISP.Desk/FreeISP.Desk.csproj --source https://api.nuget.org/v3/index.json
    dotnet build desktop/FreeISP.Desk/FreeISP.Desk.csproj -c Release --no-restore -o artifacts/releases/freeisp-desk

Distribute the entire output folder, including the WebView2 runtime loader and
DLLs. Windows needs .NET Framework 4.8 and the Microsoft Edge WebView2 Runtime.
No administrator rights are requested. Browser data stays under
`%LOCALAPPDATA%\FreeISP\Desk\Browser`; password autofill and saving are disabled.
Disconnect clears the local browser session. Use the router's Logout to terminate
its server session. Certificate errors are not bypassed.

For the VPS test router, run the existing SSH tunnel launcher first and connect
to `http://127.0.0.1:8874`. Log in with the router account, not the VPS SSH account.
For hardware, enter its HTTPS address. Credentials are never embedded in the app.

The current Quick Set target is the virtual router with named WAN/LAN interfaces.
Wireless, bridge-mode presets and VPN toggles are unavailable in this first view.
Advanced interface/VPN configuration remains in the normal OpenWrt pages.
