# FreeISP Hotspot

The Hotspot workspace provides the sections shown in the reference interface:
Servers, Server Profiles, Users, User Profiles, Active, Hosts, IP Bindings,
Service Ports, Walled Garden, Walled Garden IP List and Cookies.

This is an OpenWrt implementation. It does not implement the MikroTik API,
WinBox protocol or RADIUS.

## Set up a customer network

1. Configure a separate customer interface with a static IPv4 address, DHCP,
   DNS and forwarding to the internet using OpenWrt's network controls.
2. Keep a separate maintenance connection. Hotspot restricts customer access
   to router services, including the router's management interface.
3. Open **Network → Hotspot → Hotspot Setup** and select the customer interface.
   Setup uses that existing network; it does not readdress it or change its
   DHCP pool. Disable firewall flow offloading before enabling Hotspot.
4. Create customer accounts and assign a user profile. Use dedicated Hotspot
   passwords, separate from router administrator passwords.
5. Connect a customer device, open an HTTP page and sign in through the portal.
   Open **Active** to inspect or disconnect the session, and **Hosts** to inspect
   devices observed on the customer network.

The default portal uses HTTP captive access. It does not intercept encrypted
websites. This release's captive enforcement is IPv4; IPv6 forwarding on a
Hotspot interface is blocked to prevent access without authentication.

## Configuration and operations

Changes validate the entire configuration, preserve profile references and
reject edits made from an outdated snapshot. Passwords are stored as salted
password hashes and are not returned by the management API. Failed network
applies are reported rather than displayed as successful saves.

The service supplies live sessions, host observations and login cookies.
Those tables do not manufacture rows when no customers are connected.
Runtime failures appear in the Hotspot status, including when packages or
required network settings are missing.

**Service Ports** grants signed-in customers access to selected services on the
router itself. DNS, DHCP and the captive portal are provided automatically.
This control does not configure protocol helpers such as FTP ALG.

Hostname walled-garden entries use exact DNS names resolved to IPv4 addresses;
wildcards and URL paths are not accepted. Access follows those addresses, so
hosts sharing an address share the same access rule. Use the IP list for an
explicit destination subnet and protocol. Speed limits are traffic policers;
OpenWrt SQM remains the separate interface queue-management feature.

Configuration and durable usage state are under `/etc/freeisp/`. These files
are included in OpenWrt configuration backups and contain customer information;
keep backups private. Service execution and credentials remain on the router.

Installing the image starts the management service with no Hotspot servers
configured. It does not immediately intercept the existing LAN.

Disabling a server or its server profile removes Hotspot restrictions from that
network and restores its existing OpenWrt firewall policy. To block a customer,
disable their account or use a blocked IP binding instead.

Optional login DNS names must already resolve to the selected Hotspot address;
configure that DNS record before selecting the name in a server profile.
Usage is checkpointed every 30 seconds and during account/session changes;
an abrupt power failure can lose usage since the last checkpoint. Active
sessions require authentication again after service restart, while valid
remembered sign-ins can reconnect.

## Validation

The [recorded validation](../reports/hotspot-validation.json) covers 70 distinct
Hotspot tests: 54 portable backend/portal tests and 16 tests using real packets
inside isolated Linux network namespaces. Browser tests cover all eleven tabs.
The disposable OpenWrt 25.12.5 VM passed 21 checks, including server activation,
account/rule changes, access permissions and `fw4 check` with the persistent guard.
These results apply to the source fingerprints recorded in that report.

Run backend and runtime tests from the repository root:

```sh
python3 -m unittest discover -s tools/openwrt -p 'test_hotspot*.py' -v
node tools/openwrt/test-hotspot-ui.cjs
sudo python3 tools/openwrt/test_hotspot_runtime.py -v
```

Browser tests require Playwright and Chromium. They use a local router fixture
to exercise the actual LuCI view, including mutations and error responses.

The optional OpenWrt boot test uses a disposable copy of a supplied private
x86 image and exposes management on a random loopback port:

```sh
sudo python3 tools/openwrt/test_hotspot_vm.py --image /private/router.img.gz
```

It replaces the test copy's administrator credential, installs Python through
the guest's signed package feeds, tests authenticated and anonymous RPC access,
and checks that Hotspot assets are served. It never deploys to a live router or
changes host routes. Its private disk and validation report are retained under
`artifacts/tests/hotspot-vm/` for inspection.

Packet tests and virtual-machine evidence establish only their recorded scope.
Physical radios, access-point isolation, switch offload and customer capacity
require separate hardware and load testing.
