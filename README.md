# FreeISP Router OS

FreeISP is an independent Linux router project, starting with an isolated virtual
appliance. The planned product combines its own management interface and subscriber
controls with established Linux networking components. Laptop, small-PC and
Raspberry Pi builds are later hardware targets, not supported installation targets yet.

## Working Linux lab

The first lab boots Linux and implements IPv4 WAN DHCP, LAN DHCP/DNS, routing,
NAT, a firewall, authenticated HTTPS management and configuration backup/restore.
Changes require confirmation within 60 seconds; otherwise the previous settings
are restored. A restart loads the last confirmed configuration from a separate disk.

Read [the Linux lab instructions](linux/README.md) for building, running and recovery.
The image runs inside a VM and does not change the host's routing or firewall.
Management is bound to the host loopback address and can be reached over an SSH tunnel.

Validation boots both a router VM and a customer VM, checks real DHCP/DNS and
routed HTTP traffic, verifies WAN management isolation, and exercises configuration
recovery and persistence. Results are written to `reports/linux-vm-validation.json`.
Software tests are not a claim of physical hardware compatibility or ISP capacity.

## Not implemented yet

PPPoE, RADIUS/accounting, hotspot/vouchers, subscriber rate limits, Wi-Fi management,
RouterOS API compatibility, system-image updates and automatic image rollback remain
future work. No customer should depend on this development lab for service.

## Development

Use a dedicated Ubuntu 24.04 development machine or VPS. QEMU uses KVM when available
and slower software emulation otherwise. The build verifies an official Alpine
minirootfs checksum and obtains packages through its signed repositories.

```sh
sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils curl ca-certificates cpio e2fsprogs python3
sudo sh tools/linux/prepare.sh
sudo sh tools/linux/validate.sh
```

`tools/linux/deploy.sh` builds and tests an already-cloned Git commit, then starts
the VM under a dedicated unprivileged service account. Deploy from GitHub first.
Do not put server passwords, lab credentials, state disks or private backups in Git.

## Previous F3 experiment — withdrawn

The earlier Tenda F3 candidate was uploaded by the user, who reported no lights
and no management response afterwards. Ethernet link remained active. Its cause
and recovery are unresolved. That build is withdrawn and must not be installed on
another router. The Linux lab is separate and does not reuse the F3 hardware drivers.
