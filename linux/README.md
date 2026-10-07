# FreeISP Linux lab 0.1

An independent Linux router appliance, initially built for an isolated x86_64 VM.
It uses Alpine Linux, nftables and dnsmasq, with FreeISP configuration management
and a HTTPS web interface. This is not a laptop installer or Raspberry Pi image.
No Tenda firmware is involved. Hardware ports will require separate builds and tests.

## Current scope

- IPv4 WAN DHCP, customer DHCP/DNS, forwarding, NAT and firewall.
- Password-protected HTTPS management on LAN and a separate lab maintenance NIC.
- Settings download/restore, 60-second confirmation window and persistent last-good
  configuration. Reboot discards an unconfirmed change.
- A separate customer VM checks actual DHCP/DNS packets and routed HTTP traffic.
- No PPPoE, subscriber accounting, RADIUS, hotspot, rate limits, Wi-Fi management,
  RouterOS API, firmware upload or automatic system-image rollback yet.
- IPv6 is disabled in this initial appliance until an IPv6 policy is implemented.

This is a development build. Tests establish only the recorded virtual-lab scope.
Do not use it for a live customer network or expose its management service publicly.
The Python management server has not received a production security review.

## Lab layout

| Role | Virtual MAC | Address / purpose |
| --- | --- | --- |
| Internet | 52:54:00:f1:00:01 | DHCP from QEMU, normally 10.0.2.15 |
| Customers | 52:54:00:f1:00:02 | 10.77.0.1/24; leases .100–.199 |
| Maintenance | 52:54:00:f1:00:03 | 10.78.0.15/24; isolated management path |

Explicit MAC identities are required; missing adapters cause startup to stop.
The guest alone owns its firewall and network settings. The launcher does not
change host routing, firewall rules, bridges or physical network interfaces.
Only loopback TCP forwards are used:

- `8843`: management HTTPS.
- `8844`: negative test through the WAN interface; expected to time out.
- `18877`: virtual Ethernet socket for the separate customer test VM.

## Build on a dedicated Ubuntu 24.04 development host

The scripts download Alpine minirootfs 3.24.2 from its official distribution site,
verify the pinned SHA-256 and install packages using Alpine's signed repositories.
Resolved package versions are recorded in `packages.txt`; package revisions are
not all pinned, so rebuilds may differ. The selected packages total about 105 MiB.

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils curl ca-certificates cpio e2fsprogs python3
sudo sh tools/linux/prepare.sh
sudo sh tools/linux/validate.sh
```

Builder files reside in `/opt/freeisp-linux-root`; outputs reside under
`artifacts/releases/freeisp-linux-lab/`. These are ignored by Git. The build
creates a 64 MiB virtual state disk and never formats a physical disk. It refuses
to mount a guest state disk that lacks the expected label. A fresh build has a
random administrator password in `CREDENTIALS.txt`; keep all credentials private.

## Run and access

Install QEMU, then run `sh run.sh` from the release directory. The launcher uses
KVM if available, otherwise software emulation. Allow extra boot time on a VPS
without nested virtualization. Allocate at least 512 MiB to the router VM.

Open `https://127.0.0.1:8843`. The VM generates its own self-signed certificate on
first boot and keeps it on the state disk. Only accept the certificate for this
known private lab endpoint. Never ignore certificate errors for unrelated sites.

For a remote host, forward the loopback service through SSH:

```sh
ssh -N -L 8843:127.0.0.1:8843 USER@SERVER
```

Then use the same local URL. Nothing needs to listen on the public VPS address.
The serial console is a privileged maintenance console; access to the VM process,
its host account and the state disk must be restricted.

## Recovery and backups

The web backup contains only network settings, not passwords, certificates or the
operating system. Settings changes are applied provisionally and revert after
60 seconds unless confirmed. Restart always loads the most recent confirmed file.
The separate maintenance interface keeps the UI reachable when LAN settings change.

Keep the kernel, initramfs and a stopped-VM copy of `state.raw` to recover the lab.
Do not copy the state disk while the VM is writing it. Retaining an older system
image is manual recovery, not an implemented A/B updater. The serial console can
be used if the management application exits. No host reboot is required.

## Evidence

`reports/linux-vm-validation.json` records image hashes and actual VM checks.
`tests/test_linux_appliance.py` tests validation, failed applies, confirmation,
timeout restore and restart semantics. VM tests additionally exercise DHCP, DNS,
NAT, WAN management denial, authentication, restore and persisted state after a
VM process restart. These do not establish Wi-Fi, physical-driver reliability,
customer capacity or sustained throughput.

## Components

Upstream source and license information: [Alpine](https://alpinelinux.org/),
[Linux](https://www.kernel.org/), [nftables](https://netfilter.org/projects/nftables/),
[dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html), [Python](https://www.python.org/),
and [QEMU](https://www.qemu.org/). Keep the package manifest with redistributed
builds and satisfy the corresponding source/license obligations before a public
binary release. Current deployment builds its own private lab artifact from source.
