# PPPoE subscriber service

The FreeISP PPPoE page manages local subscriber accounts on the OpenWrt router.
The backend uses the official `rp-pppoe-server`, `pppd` and Linux traffic-control
packages. No RADIUS dependency is introduced. FreeISP Desk displays the same
router-served page; its local Device Hub does not depend on these packages.

## Set up

1. Create an **Address Pool** outside existing LAN, WAN and management subnets.
2. Create a **Profile** with the router's PPP local address, a pool, DNS servers
   and optional download/upload rates in kbit/s. Zero means unlimited.
3. Create a **PPPoE Server** on an existing, enabled Ethernet, bridge or VLAN
   device and select its default profile. The service name is advertised to clients.
4. Add a **Secret** containing the username, password and server. A secret can
   override the server's default profile and reserve a specific address in its pool.
5. Select **Save & apply**. The router validates settings and restarts the PPPoE
   service. Current subscribers disconnect and may reconnect with the new settings.

Profiles and pools can be created before a server. Pools reserve one stable
IPv4 address per account, including disabled accounts; they are not a shared
dynamic lease pool. Exhaustion is rejected when saving. One active connection
per account is permitted. Disabled accounts do not authenticate.

The **Active Connections** tab reads live process and interface state, address,
uptime and byte counters. Download is traffic sent to the subscriber; upload is
traffic received from the subscriber. Disconnect terminates that specific PPP
process; clients may reconnect unless their account is disabled and applied.
These are cumulative counters, not instantaneous bit rates.

## Persistence, errors and access

Settings are stored atomically in `/etc/freeisp/pppoe.json`, mode 0600, and are
included in OpenWrt configuration backups. Passwords are never returned by the
management API. Generated pppd options and authentication files are private and
separate from WAN/client files. CHAP authentication is required.

Save checks the revision to reject concurrent edits. Backend validation covers
references, duplicate names and addresses, pool overlap/exhaustion, device state,
MTU and rate limits. A failed service restart restores the prior configuration
and attempts to restart it; rollback failure is reported explicitly. A lost
connection during save locks further edits until reload confirms the result.

The rpcd ACL separates read operations (`get`, `status`) from write operations
(`save`, `disconnect`). It grants no arbitrary shell or file access. Session
disconnect checks PID start time to avoid signaling a recycled process.

Subscriber interfaces use the `fi-` prefix and a dedicated IPv4 firewall zone.
Forwarding to WAN is permitted, while access to router management, LAN and other
subscribers is rejected. Set DNS servers that subscribers can reach through WAN;
the router's own DNS service is not exposed to the subscriber zone by default.
IPv6 subscriber service is not implemented.

## Build and verification

The overlay adds the procd service, rpcd executable, hook scripts, menu, ACL and
web view. `tools/openwrt/build.sh` installs the executable modes. First-boot
setup registers the service, firewall zone and configuration backup path.

- Backend regression checks: `python3 -B tools/openwrt/test_pppoe.py` on Linux.
- Browser checks: `node tools/openwrt/test-pppoe-ui.cjs` with Playwright available.
  Set `FREEISP_BROWSER_CHANNEL=msedge` when using the installed Windows browser.
  These use a fixture, not a live router, and write screenshots under `artifacts/`.
- Real packet checks: `tools/openwrt/pppoe-lab.sh` runs two disposable OpenWrt VMs
  in the existing local Linux builder. The script uses the private base image and
  credentials from the local `artifacts/releases/freeisp-openwrt-vps` directory.
  It does not connect to the deployed VPS. Results are saved under
  `artifacts/pppoe-lab/results.json`; credentials are not included.
- FreeISP Desk: build the Windows project and run the resulting executable with
  `--self-test`. That test blocks external web requests and verifies the local hub.

The Windows live-browser integration check is `tools/openwrt/test-pppoe-live-ui.cjs`.
Set `FREEISP_TEST_CREDENTIALS` to the private local test credentials file and run
the VM harness with `FREEISP_PPPOE_BROWSER_ONLY=1` first. It uses only the disposable
VM on localhost port 23976. The harness clears that VM's PPPoE test configuration,
waits up to three minutes for the browser check and then stops both guests.

Verified during development on OpenWrt 25.12.5 x86/64: actual CHAP login and wrong
password rejection; pool allocation; routed WAN traffic; measured download and
upload limits; management isolation; live counters; session disconnect; read-only
API permissions; invalid/stale save rejection; settings and service persistence
after reboot; reconnection; account disable and configuration deletion. Browser
fixture checks also exercise lost connections and ambiguous save outcomes. The
real LuCI browser check creates, saves, reloads and edits pools/profiles. Desk's
offline test verifies the bundled hub, browser bridge and logo with external
requests blocked. These checks do not establish production-scale capacity.

The PPPoE implementation is intended for the current x86 VM platform. Hardware
targets and production subscriber scale require their own packet and load tests.
