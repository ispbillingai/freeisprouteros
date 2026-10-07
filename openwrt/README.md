# FreeISP on OpenWrt

The active product direction is an OpenWrt-based router with FreeISP customization.
The earlier `linux/` appliance is retained as a migration reference and packet-test client.
Do not continue building competing networking services there.

## Base and customization

Official OpenWrt 25.12.5, x86/64 generic, built with the official Image Builder.
The builder archive is SHA-256 pinned; package signatures are checked by its package manager.
Feed package versions can change; each image records its installed manifest and source commit.

- `files/` is the FreeISP overlay; upstream OpenWrt code stays intact.
- `packages.txt` selects official packages. No RADIUS service or integration is included.
- FreeISP and FreeISP Night add compact, WinBox-inspired left navigation and CSS on top of LuCI Bootstrap. Bootstrap and OpenWrt 2020 remain selectable.
- The FreeISP landing view links to real LuCI controls, not simulated settings.
- Themes, logo, menu, modules and defaults can be changed independently of the operating system.
- Upstream copyright and licensing notices are retained. Theme templates retain Apache-2.0 notices.

## What is provided

The dedicated [Bridge workspace](BRIDGE.md) provides bridge, port, VLAN and
learned-host controls and telemetry, with local drafts and confirmed apply.
See its validation notes for the exact tested scope and remaining checks.

LuCI interface/device/bridge/VLAN controls; DHCP/DNS; firewall/NAT/port forwarding;
static routing; PPPoE **client** support; WireGuard protocol configuration;
SQM interface shaping; per-host traffic accounting (nlbwmon); diagnostics;
system/kernel logs; package management; backup/restore/firmware tools; authenticated commands.
Installed does not mean every protocol has been integration-tested or configured.

The [FreeISP Log page](LOGS.md) reads the real system log buffer with live polling,
Freeze/Resume, filters and text download. Its documentation distinguishes browser
regression checks from tests against an actual OpenWrt guest.
## Queue List

The Queues menu opens four reference-style tabs. **Interface Queues** manages real
SQM configuration: add, edit, enable/disable and remove queues, review the pending
changes, then apply with LuCI's connection check and rollback. Rates are whole
kbit/s; zero disables shaping in that direction. Enabled queues enable SQM at boot.
The editor rejects duplicate enabled queues on one interface, unavailable devices,
invalid rates and missing queue types/scripts. It preserves advanced SQM options
when editing the basic fields. The existing SQM editor remains available for
advanced options and service setup.

The page reads queue types and scripts from the router, and polls kernel queue
observations every five seconds. Observed upload queues, CAKE rates and byte
counters are separate from configured settings; failed reads show unknown status.
This view does not verify download enforcement or measure end-to-end throughput.
Pending external changes and concurrent edits block applying stale settings.
Read-only users can inspect queues; the write ACL is restricted to SQM settings
and enabling its boot service.

**Simple Queues and Queue Tree remain unavailable**: per-IP/subscriber limits,
dynamic PPPoE/hotspot queues, hierarchical classification and counter reset need
additional backend work. The tabs say so and do not expose simulated actions.
Queue Types lists available/configured disciplines; it does not create kernel
queue implementations.

Local checks:

```
node tools/openwrt/test-queues.cjs
node tools/openwrt/test-queues-ui.cjs
```

The browser checks require Node 20+ and Playwright. Set
`FREEISP_BROWSER_CHANNEL=msedge` to use installed Edge.
For real integration tests, use **only a disposable local OpenWrt VM** and set
`FREEISP_QUEUE_TEST_DISPOSABLE=yes`, `FREEISP_QUEUE_TEST_URL`, and
`FREEISP_QUEUE_TEST_CREDENTIALS` (a private JSON file containing `password`).
Run `tools/openwrt/test-queues-router.cjs` through Node for real LuCI actions,
invalid inputs, reboot persistence, removal and connection failure/recovery.
Run `tools/openwrt/test-queues-packets.py` on the QEMU host for local packet
traffic and restricted-account ACL checks. Its local witness listens on port
18992, which the guest reaches at 10.0.2.2. These tests require an isolated test
administrator allowed to execute preparation/reboot commands; never ship the
test harness's broader permissions in a product image. Results and screenshots
go under ignored `artifacts/tests/`. See `reports/queues-validation.json` for
the recorded validation scope and limitations.

SQM field semantics follow the
[upstream LuCI SQM view](https://github.com/openwrt/luci/blob/openwrt-25.12/applications/luci-app-sqm/htdocs/luci-static/resources/view/network/sqm.js).

## Remaining platform work

PPPoE **server**, subscriber accounts/plans, captive hotspot, per-subscriber enforcement,
AP controller and the dashboard compatibility contract remain additional product work.
RADIUS is explicitly out of scope. CAPsMAN, MetaROUTER, WinBox and MikroTik support.rif
are vendor-specific features, not OpenWrt features that can be renamed into existence.
Wireless, switch offload, mesh and 802.1X need suitable hardware and their own tests.

## Files

The Files screen browses persistent `/srv/freeisp-files` storage with folder
navigation, search, upload, binary download and confirmed single-file deletion.
It does not browse system configuration, follow symlinks, or remove directories.
Backup and Restore open the existing OpenWrt configuration tools; these archives
do not automatically include the Files storage directory. Download user files
separately before reflashing. Cloud Backup is explicitly unavailable. Timestamps
show modification time; the footer totals listed file sizes, not disk capacity.

Browser interaction and failure checks: `node tools/openwrt/test-files-ui.cjs`
(requires Playwright with Chromium; set `FREEISP_BROWSER_CHANNEL=msedge` to use
an installed Edge browser). These checks use simulated RPC responses.

Real backend checks: on a Linux test host with QEMU, OpenSSL and mount support,
run `FREEISP_TEST_IMAGE=/private/freeisp-openwrt-x86-64.img.gz python3 tools/openwrt/test-files-backend.py`
as root. This creates a disposable VM using a copy of the supplied image,
exercises rpcd and CGI actions, checks restricted accounts and two guest reboots,
then removes the temporary disk. Reports are under `artifacts/tests/files`.
This does not deploy to the VPS or test customer packet forwarding.

## VPS lab and access

This is a guest VM, not a replacement for the Ubuntu host. Host routes are untouched.
Three MAC-assigned NICs: WAN, bridged LAN 10.77.0.1/24, maintenance 10.78.0.15/24.
LAN DHCP pool 10.77.0.100–199; management stays separate from LAN changes.
The host publishes management only on loopback, reached via SSH. LAN management uses HTTPS.
The default VM build has no Wi-Fi hardware. Physical routers require a device-specific build.

On an Ubuntu build host, from a GitHub checkout:

```
FREEISP_CREDENTIALS=/private/credentials.json sh tools/openwrt/stage.sh
```

The private JSON must contain `password`. It is converted to a salted SHA-512 root hash.
Never commit this file or publish the personalized image. This is the OpenWrt guest root
password, distinct from the VPS root account even if an operator chooses otherwise.
On first boot the seed hash is moved into `/etc/shadow` and its seed file removed.

Stage on port 8890, validate before switching the existing SSH tunnel's port 8874.
Keep the old VM disk and service as a rollback option. Rebooting the guest restarts its
service; stopping the service intentionally does not restart it.

## Recovery limits

OpenWrt provides configuration rollback and backup/restore, but neither guarantees
recovery from every bad package or firmware image. The VPS operator retains SSH access
to Ubuntu and can stop the VM and restore its disk backup. Replacing a guest disk loses
changes made since that backup. Physical hardware requires a separate recovery design.

Sources: [official release](https://downloads.openwrt.org/releases/25.12.5/targets/x86/64/),
[LuCI source](https://github.com/openwrt/luci/tree/openwrt-25.12),
[Image Builder](https://openwrt.org/docs/guide-user/additional-software/imagebuilder).
