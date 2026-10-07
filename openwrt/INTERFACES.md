# Interfaces and VLANs

The FreeISP **Interfaces** sidebar opens four tabs:

- **Interface**: live device status, measured transmit/receive rates and packet totals.
- **Interface List**: OpenWrt logical networks, protocols, assigned devices and addresses.
  Configure networks opens the existing OpenWrt controls for addressing and assignment.
  These are OpenWrt networks, not MikroTik firewall interface-list groups.
- **Ethernet**: wired ports, link status, reported speed, MTU and MAC address. Edit MTU
  or MAC. An empty MTU applies the standard Ethernet value of 1500. An empty MAC
  removes the saved override; a device restart restores the hardware address.
- **VLAN**: add, edit and remove explicit 802.1Q or 802.1ad VLAN devices. Configure
  name, parent interface, VLAN ID (1–4094), protocol and optional MTU.

Edits stay in the page until **Review & apply**. Discard restores the loaded state.
Apply saves only the edited network device sections and calls LuCI's checked apply,
including its connectivity confirmation and rollback. Existing pending UCI changes
or a changed network configuration block saving. A failed/partial save locks the
page until pending changes are reviewed and the page is reloaded.

VLAN creation defines a tagged device. Assign it to a logical network using
**Interface List → Configure networks** to configure addressing. Bridge access/trunk
membership, implicit VLANs and VLAN-filtered bridges stay in the existing
**Bridge / VLAN** controls. This page does not change bridge ports, firewall zones,
DHCP, PPP, routing, wireless or service configuration.

Duplicate names/tags, invalid parents, cyclic parent chains and parent MTU violations
are rejected. A VLAN referenced by a network, bridge or child VLAN cannot be renamed
or removed until those references are removed. Existing advanced device options are
preserved when supported fields are edited.

## Local validation

From the repository root:

```text
node tools/openwrt/test-interfaces.cjs
node tools/openwrt/test-quickset.cjs
node tools/openwrt/test-interfaces-ui.cjs
```

The browser suite requires Playwright and its Chromium browser. It can use installed
Edge with `FREEISP_BROWSER_CHANNEL=msedge`; `NODE_PATH` can point to an existing
Playwright installation. CI installs the pinned dependency. Screenshots and results
are written to ignored `artifacts/tests/interfaces/`.

The browser tests run the actual view with local RPC/UCI fixtures and exercise all
four tabs, VLAN add/edit/delete, Ethernet editing, validation, search, discard,
review, scoped writes, rollback selection, concurrent changes, save errors,
read-only access, connection errors and Day/Night/mobile layouts.
These fixture tests alone do not prove tagged packet forwarding.

For real backend tests, place a private FreeISP ext4 factory image at
`artifacts/tests/interfaces-vm/base.img.gz`. On a local Linux machine with QEMU,
Python, OpenSSL, OpenSSH, sshpass and root access for mounting disposable disk copies, run:

```text
sudo env FREEISP_TEST_WAIT_UI=1 python3 tools/openwrt/test-interfaces-vm.py
```

After `LOCAL_BROWSER_READY`, run `node tools/openwrt/test-interfaces-live.cjs` in
another terminal with access to the same workspace and localhost ports. The helper
creates temporary credentials, boots two local guests, checks VLAN traffic and
reboot persistence, and removes the temporary guests and session file on exit.
The live browser test accepts only the helper's localhost connection. Its screenshots
and reports are stored under `artifacts/tests/interfaces-vm/`. Omitting
`FREEISP_TEST_WAIT_UI` runs the backend checks without the browser handoff.

No VPS deployment is part of this change. Physical hardware needs separate testing.
