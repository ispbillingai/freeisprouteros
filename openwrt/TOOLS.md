# FreeISP router Tools

The FreeISP Tools page is `/cgi-bin/luci/admin/network/freeisp_tools`. FreeISP
Desk 0.2.3 opens it through **Router Tools** after connecting. The Device Hub
still loads from bundled local files without an internet or router connection.

These tools use OpenWrt services and utilities. They do not implement the
MikroTik binary protocols. The page lists all 20 entries in the supplied Tools
menu and distinguishes missing dependencies from unsupported protocols.

| Screenshot entry | Implemented behavior and limits |
| --- | --- |
| BTest Server | Persistent, supervised iperf3 server. Disabled by default. Bind to an assigned IPv4 address; no firewall rules are opened automatically. Uses iperf3 clients, not RouterOS BTest. |
| Bandwidth Test | Five-second TCP iperf3 upload or download; displays actual tool output and failures. |
| Email | Persisted STARTTLS relay configuration, authenticated sending, certificate verification, explicit relay acceptance or failure. SMTP passwords stay out of status replies and command arguments. |
| Flood Ping | Twenty ICMP packets at 100 ms intervals; bounded runtime. |
| Graphing | Thirty recent samples of aggregate interface traffic. Session history only; bridge counters may count traffic twice. No historical database. |
| IP Scan | Active IPv4 ICMP discovery over /28–/32, at most 16 addresses. Nonresponding hosts are not proof of absence. |
| MAC Server | **Not implemented:** MikroTik MAC Telnet / MAC WinBox server. |
| Netwatch | Persistent single-host ping monitor; current up/down result, timestamp and transitions in system log. No arbitrary transition scripts. |
| Packet Sniffer | Device/host-filtered packet header sample; 50 packets or five seconds. No PCAP export or payload display. |
| Ping | Five probes, bounded wait, actual loss and latency output. |
| Ping Speed | Large ICMP probes only. **Not RouterOS ICMP throughput estimation.** |
| Profile | Kernel process CPU/memory snapshot. Not RouterOS subsystem accounting. |
| RoMON | **Not implemented:** MikroTik RoMON overlay. |
| SMS | ModemManager send adapter with modem/number/text validation. Requires optional ModemManager, supported modem and SIM. No hardware validation was possible; not included in the default VM package set. |
| Telnet | TCP connection/banner check only. **Interactive Telnet is unfinished.** |
| Torch | Bounded packet header sample. **Full flow aggregation is unfinished.** |
| Traceroute | Eight hops, one probe per hop, bounded runtime. |
| Traffic Generator | Five-second UDP iperf3 generation, 1–10 Mbit/s. Requires an iperf3 receiver; not an arbitrary packet generator. |
| Traffic Monitor | Live device counters and rates; no persistent threshold alerts. |
| WoL | Sends a magic packet on the selected device. Packet transmission does not prove that the target woke. |

## Backend and persistence

`freeisp.tools` is a dedicated rpcd executable with `status`, `run` and `save`
methods. Read access permits status only; running tools and saving settings
require write access. Arguments are validated server-side and shell quoted;
there is no free-form command or packet-filter input. Actions are time-limited
and captured output is capped at 32 KiB. Browser connection failures invalidate
live status instead of retaining a green state.

`/etc/config/freeisp_tools` stores server, monitor and SMTP settings with mode
0600. SMTP uses a private temporary spool which is removed after the attempt.
`/etc/init.d/freeisp-tools` supervises the server and monitor through procd.
`/var/run/freeisp-netwatch.json` holds volatile probe state. Settings survive
reboot; probe results and graph history do not.

New images include coreutils-timeout, iputils-ping, iperf3, fping, etherwake,
msmtp and ca-bundle in addition to the existing tcpdump and network utilities.
The image builder sets executable permissions and configuration permissions.
Existing installations need these packages and overlay files installed through
the normal reviewed deployment process, followed by rpcd reload/restart and
enabling `freeisp-tools`. Replacing a live configuration with the default file
would erase saved tool settings; preserve existing `/etc/config/freeisp_tools`.

## Verification performed on 2026-10-07

Tests used a disposable copy of the existing OpenWrt 25.12.5 x86/64 image,
official packages, a loopback-only HTTP management forward, and local fixtures.
No production VM or physical router was changed.

- `tools/openwrt/test-tools-vm.py`: real ping, rapid ping, large ping, traceroute,
  counters/process data, TCP/UDP transfers, scanning, captured ICMP traffic,
  observed WoL Ethernet packet, Netwatch up/down, server lifecycle, refused
  connections, invalid/injection inputs, anonymous RPC denial, hidden SMTP
  password, missing SMS dependency, reboot persistence, existing board/network
  status and DHCP configuration.
- `tools/openwrt/test-tools-ui.cjs`: real authenticated LuCI page, all 20 tools,
  ping, invalid input, unsupported actions disabled, connection failure, saved
  settings after reload, graph rates and stale status after going offline.
  The stock login page emits a pre-authentication UCI access-denied console
  warning; the report records it separately. The authenticated tools tests
  have no browser exceptions.
- `tools/openwrt/tools-smtp-fixture.py`: actual STARTTLS/authentication and message
  receipt at a private local SMTP sink, quoted credentials and rejected header
  injection. No messages are forwarded to external recipients.
- Windows Release build and `--self-test`: offline WebView requests blocked,
  rendered hub/logo, invalid addresses, loopback authentication success/failure,
  rejected empty session, redirects not followed, refused connection, saved
  router cards and Day/Night storage, including a second process launch.
  `--self-test --tools-router-test` additionally passed real login to the local
  OpenWrt VM, opening the native Router Tools button and running a real ping
  from the embedded tool page.
- Existing Quick Set validation and JavaScript, shell and JSON checks.

These checks do not establish full RouterOS parity, physical device wake-up,
modem/SIM operation, production throughput, remote mail delivery, or regressions
across every OpenWrt networking feature. The complete personalized image was
not rebuilt, and no VPS deployment is claimed.

## Reproduce the VM checks

On an isolated Linux test host with QEMU, Python 3, OpenSSL and mount privileges:

```sh
FREEISP_TOOLS_IMAGE=/private/existing-openwrt.img.gz sh tools/openwrt/tools-vm.sh
```

Keep that process running. In another terminal run
`python3 tools/openwrt/test-tools-vm.py --install`, check `--install-status`,
then run the script without arguments. Run `tools-smtp-fixture.py` separately.
The boot script creates a fresh private copy and a test-only file RPC ACL;
that ACL and the fixed local test password are never part of the product overlay.
The suite intentionally reboots only this disposable guest. Port 18940 and the
console socket `/tmp/freeisp-tools-console.sock` are reserved for this fixture.
Use one Tools fixture at a time, then stop its QEMU process.

The browser suite needs Node 20+, Playwright and Edge, with the test VM reachable
at loopback port 18940. Build FreeISP Desk and run its executable twice with
`--self-test`; each run uses an isolated profile beside the executable. Reports
and screenshots are written under ignored `artifacts/` output directories.
For the optional Windows-to-VM check, run `--self-test --tools-router-test`.
Only the fixed loopback test VM is permitted by that test's browser filter.
