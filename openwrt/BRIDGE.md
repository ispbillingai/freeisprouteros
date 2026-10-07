# FreeISP Bridge workspace

The Bridge / VLAN sidebar entry and Quick Set shortcut open
`admin/network/freeisp_bridge`. FreeISP Desk displays this router-served page;
its offline Device Hub does not depend on these files.

## Controls

- **Bridge:** create/remove bridges; MTU and MAC overrides; empty-bridge
  behavior; STP, priority and timers; MAC ageing; VLAN filtering; IGMP snooping,
  querier and multicast timers. The table reports actual device state, MTU,
  MAC, measured bit/packet rates and port count.
- **Ports:** add/detach wired devices, with checks for routed-device ownership,
  multiple bridge membership and loops. Configure MAC learning, unknown-unicast
  flooding, isolation, multicast conversion, fast leave and router mode. Link,
  STP state, path cost and PVID come from the running bridge.
- **VLANs:** add/edit/remove IDs 1–4094; tagged/untagged membership; one explicit
  PVID per port; local/CPU participation. Duplicate IDs, conflicting PVIDs and
  removal of referenced VLANs are rejected. VLAN filtering is a separate
  bridge setting. IP, DHCP and firewall configuration stays in Interfaces.
- **Hosts:** read-only Linux forwarding database, with MAC, bridge, port,
  VLAN, dynamic/static/local classification, flags and available age counters.
  This is not an IP-neighbor table. Entries are not fabricated from DHCP leases.

All tables have search, bridge filtering, sortable columns, 100-row pagination
and CSV export of every matching row. Hosts also have a type filter. Polling
runs every five seconds and can be paused or refreshed manually. Day/Night
themes and narrow screens are supported. Missing counters remain unavailable;
failed device polls mark retained runtime data stale.

## Persistence and permissions

Edits remain in a page-local draft until **Review & apply**. Review lists
changed fields. Apply checks for existing pending changes and concurrent
network edits, writes through LuCI UCI, then invokes the standard confirmed
OpenWrt apply/rollback flow. Partial save failures lock further writes until
the operator reviews pending changes and reloads. Discard never writes.

Existing device and VLAN section options are preserved unless edited. Bridge
names are immutable here because renaming can break other services. Runtime
bridges without modern `config device` sections remain visible and link to
Interfaces for management. Wireless membership belongs to wireless settings.

`ip-bridge` supplies runtime telemetry. A fixed, argument-free
`/usr/libexec/freeisp-bridge-status` helper queries JSON link/FDB/VLAN state.
The dedicated ACL grants execution of only that helper, device status reads,
and network UCI access. A read-only role can inspect data but cannot save.
The build script sets the helper executable; Git preserves its LF endings.

No RouterOS FastPath/offload counters, RSTP/MSTP service, hardware L2 MTU,
static FDB persistence or host-flush actions are implied by this page. Only
supported OpenWrt settings are exposed. Bridge VLAN entries describe configured
policy; Hosts and port PVID columns describe running state.

## Validation

Run from the repository root:

```sh
node tools/openwrt/test-bridge.cjs
node tools/openwrt/test-quickset.cjs
# Node 22+, Playwright 1.62.1 and its Chromium browser:
node tools/openwrt/test-bridge-ui.cjs
```

Browser tests run the production view with simulated UCI/RPC. They exercise
create/edit/apply/reload, invalid input, dependency protection, discard,
read-only mode, existing pending changes, concurrent changes, failed saves and
applies, lost telemetry, recovery, filtering, pagination, CSV and both themes.
Screenshots and results are under `artifacts/tests/bridge/`.

For real backend tests on Linux, supply a local FreeISP OpenWrt ext4 combined
image, the official matching `ip-bridge-6.18.0-r2.apk`, and its signed
`packages.adb` alongside the APK. Run as root:

```sh
sh tools/openwrt/bridge-test-image.sh /path/router.img.gz "$PWD" \
  "$PWD/artifacts/tests/bridge-backend" /path/ip-bridge-6.18.0-r2.apk
node tools/openwrt/test-bridge-captured.cjs
```

The runner verifies the package through the signed repository index and uses
a disposable image copy in new mount, PID and network namespaces. It does not
boot or modify the source image or the host network. Two client namespaces
exercise real untagged access and tagged trunk traffic; an unconfigured VLAN
must fail. The suite checks MAC learning, isolation, MTU, UCI reload/restart
persistence, port/VLAN/bridge removal, and actual RPC helper/UCI permissions.
The capture test verifies the production parser against those real responses.

Verified locally on 2026-10-07: model and browser suites; real OpenWrt 25.12.5
userspace under the WSL Linux kernel; Quick Set validation; FreeISP Desk Release
build with cached dependencies and its `--self-test` with external WebView
requests blocked. The offline Hub, native bridge and embedded logo loaded.

Still requires a staged full-router integration run: booting the new image,
management disconnection and timed rollback/reconnect through the real web
server, physical switch/offload behavior and production-scale FDB performance.
The namespace test demonstrates real backend behavior and service-restart
persistence, not a full firmware reboot. No production deployment is performed.

Implementation references: [LuCI network controls](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-mod-network/htdocs/luci-static/resources/tools/network.js),
[OpenWrt iproute2 packaging](https://github.com/openwrt/openwrt/blob/openwrt-25.12/package/network/utils/iproute2/Makefile).
