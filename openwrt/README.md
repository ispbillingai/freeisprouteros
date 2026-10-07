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

LuCI interface/device/bridge/VLAN controls; DHCP/DNS; firewall/NAT/port forwarding;
static routing; PPPoE **client** support; WireGuard protocol configuration;
SQM interface shaping; per-host traffic accounting (nlbwmon); diagnostics;
system/kernel logs; package management; backup/restore/firmware tools; authenticated commands.
Installed does not mean every protocol has been integration-tested or configured.

The [FreeISP Tools workspace](TOOLS.md) adds authenticated diagnostic actions,
packet sampling, throughput tests, persistent Netwatch and iperf3 service settings,
SMTP and Wake-on-LAN. Its feature matrix documents the supported equivalents,
actual test evidence and remaining gaps in RouterOS parity.

PPPoE **server**, subscriber accounts/plans, captive hotspot, per-subscriber enforcement,
AP controller and the dashboard compatibility contract remain additional product work.
RADIUS is explicitly out of scope. CAPsMAN, MetaROUTER, WinBox and MikroTik support.rif
are vendor-specific features, not OpenWrt features that can be renamed into existence.
Wireless, switch offload, mesh and 802.1X need suitable hardware and their own tests.

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
