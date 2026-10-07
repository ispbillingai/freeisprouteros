# WiFi workspace

FreeISP's WiFi menu uses the installed OpenWrt LuCI wireless editor for real
interface, radio and client actions. It does not emulate a MikroTik backend.
Quick Set and Overview link to the same workspace. FreeISP Desk displays these
router-served pages after connection; its bundled offline hub is independent.

## Controls and backend

| Tab | Function and backend |
| --- | --- |
| WiFi Interfaces | Unmodified `network/wireless` LuCI view: add/edit/remove SSIDs, enable/disable, restart radio, scan/join, associated stations and supported disconnect actions. Native forms write UCI `wireless`, `network` and `firewall`; native actions call the existing WiFi/hostapd services. |
| Security Profiles | CRUD for personal-security templates in `/etc/config/freeisp_wifi`. Choose interfaces to copy validated settings into UCI `wireless`, then use normal LuCI Save & Apply. |
| Channels | Configured radio settings, current channel from LuCI network state, driver frequencies from `iwinfo.freqlist`. Edit opens the native WiFi editor, whose Device Configuration controls country, channel, band, width, power and advanced settings. |
| Access List | Actual per-AP MAC policy, MAC list, isolation and client limits from UCI. Edit opens the native MAC-Filter and advanced settings. |
| Registration | Live `iwinfo.assoclist` reads for active interfaces and their VLAN devices every five seconds. Shows signal/noise, negotiated RX/TX rates and inactivity. Failed reads are distinguished from empty results; a failed refresh labels previously displayed data as stale. Disconnect is available in the native Associated Stations table. |
| Connect List | Actual configured station interfaces, SSID, BSSID lock, security and network binding. Native Scan/Join creates client connections; this is not an automatic failover policy. |
| Tools & Coverage | Locations of all available editor controls, diagnostic links and explicit platform limitations. |

The native editor also handles hidden SSIDs, AP/client/WDS/mesh modes,
bridge/network assignments, WMM, multicast, roaming assistance (802.11r/k/v),
protected management frames and other driver-specific tuning. Its capability
checks and regulatory constraints remain upstream rather than being duplicated.
Changing a radio affects every SSID using it. Guest network isolation also needs
the intended bridge/VLAN, DHCP and firewall configuration.

## Security template behavior

- WPA2 Personal (AES), WPA3 Personal, WPA2/WPA3 mixed and Enhanced Open (OWE).
  OWE encrypts traffic without authenticating a password.
- Passphrases are 8–63 printable ASCII characters. WPA2 also accepts a 64-digit
  hexadecimal PSK. Password whitespace is preserved, never trimmed.
- WPA3 and OWE require PMF; mixed mode requires optional or required PMF.
- Validate all targets before staging any changes. Reject unsupported modes,
  missing services/capabilities, incompatible mesh/6 GHz configurations and
  advanced/enterprise security requiring the native editor.
- Copy only encryption, password, PMF and group rekey interval; disable WPS.
  Preserve SSID, network, MAC policy, radio settings and disabled state.
- Copies are independent. Editing/deleting the template does not silently update
  existing interfaces. Apply/revert pending WiFi changes before another copy.
- Template editing uses LuCI's standard Save/Save & Apply/Reset. Choosing targets
  first saves template edits to the pending configuration; cancelling the target
  dialog does not modify any interface.
- No default SSID, radio or password is created. Secrets use password fields,
  are absent from table summaries and copy confirmations, and are stored in a
  mode-0600 configuration file. Router backups include these secrets.
- ACLs require the native network configuration group plus the WiFi group.
  The extra group grants only the required UCI/status access, with no new shell
  execution or arbitrary file permission. Read-only sessions cannot stage copies.

## Hardware and platform limits

The current x86 VM has no radio. An empty wireless configuration keeps the menu
available without inventing radios. Existing hardware-generated configuration is
never replaced by the WiFi initialization script. Hardware targets still need a
device-specific build, appropriate drivers, regulatory data and a compatible
hostapd/wpa-supplicant package. No physical-target package selection was changed.

CAPsMAN/CAP, Nstreme Dual, proprietary W60G controls, MikroTik Interworking
Profiles, spectrum utilization, Alignment, Sniffer/Snooper, automatic repeater
setup, Passpoint/Hotspot 2.0 and AP-controller provisioning are not implemented.
Nearby-network scanning is not spectrum measurement. RADIUS integration remains
outside FreeISP's scope. Native LuCI may expose options supplied by the installed
upstream packages; that does not establish FreeISP integration support.

## Validation evidence (2026-10-07)

Run from the repository root:

```
node tools/openwrt/test-wifi.cjs
node tools/openwrt/test-wifi-views.cjs
node tools/openwrt/test-quickset.cjs
```

Passed: 47 invalid-input/capability cases; pure planning; unrelated-field
preservation; menu and ACL checks; actual view-handler execution with test doubles
for staging, cancellation, pending-change conflicts, read-only access, all-target
validation, backend save rejection, absent radios and failed/stale status reads.
The serialized test-store reload checks the intended saved values, **not real
router persistence**. Quick Set's existing address/subnet/DHCP validation passes.

`node tools/openwrt/test-wifi-browser.cjs` additionally requires Node 20+ and
Playwright, using installed Edge by default (`WIFI_BROWSER_CHANNEL` can override).
Passed local fixtures for WiFi tab navigation, profile staging, secret masking,
day/night appearance and mobile empty state. Screenshots are under ignored
`artifacts/wifi-ui/`. These use test data and are not router integration evidence.

The existing FreeISP Desk 0.2.2 executable also passed its `--self-test` in the
isolated worktree: exit 0, hub `passed=true`, bridge and logo present, with external
WebView requests blocked and no router. Results and screenshot are under ignored
`artifacts/desk-offline/`. No Windows application source was changed.

Not yet tested: loading these pages on an installed OpenWrt image, actual UCI
profile persistence across router reboot, rollback/reconnect after WiFi changes,
real radio scanning/association, channel/DFS behavior, client isolation, roaming,
mesh and radio power. Browser fixtures do not establish those behaviors. No image
was built, no deployment was made and no live router configuration was changed.

Before deployment, review and push the commit, then test a separate router/image:

1. Load every WiFi tab as administrator and a read-only user, including no-radio
   and down-radio states. Verify required package/driver absence is reported.
2. Create/edit/save a template; open a second authenticated session and verify its
   values. Reboot the test router and verify persistence; delete the test template.
3. On supported hardware, create a disabled test AP and copy a profile. Verify
   pending UCI changes, Save & Apply, reconnect/rollback and retention of unrelated
   settings. Test invalid settings and a lost management connection.
4. Test scan/join, restart, enable/disable, client association/disconnect, channel
   restrictions, MAC rules and guest isolation with real clients. Validate optional
   mesh/WDS/roaming only on supported equipment.
5. Recheck wired management, WAN/LAN, DHCP/firewall and the Desk offline hub.

References: [OpenWrt 25.12 LuCI wireless editor](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js),
[network ACLs](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-mod-network/root/usr/share/rpcd/acl.d/luci-mod-network.json),
[WiFi service variants](https://github.com/openwrt/openwrt/blob/openwrt-25.12/package/network/services/hostapd/Makefile).
