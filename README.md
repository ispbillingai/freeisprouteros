# FreeISP Router OS

FreeISP builds on **OpenWrt**, with our own interface, Day and Night themes,
package selection and releases. **FreeISP Desk** is the Windows management app.
RADIUS is excluded from the product.

## Active projects

- [OpenWrt platform](openwrt/README.md): router configuration, networking,
  FreeISP Quick Set, themes and image builds. Source overlays live in `openwrt/`;
  build and validation tools live in `tools/openwrt/`.
- [FreeISP Desk](desktop/README.md): the Windows app, local device hub,
  saved connections and gateway discovery. Source lives in `desktop/`.
  The device hub opens locally; connecting requires a reachable router.

The current router target is an x86/64 virtual machine. Physical devices need
separate supported hardware targets, builds and validation.

## Development and releases

Use the instructions in each active project's README. Develop parallel features
in separate Git worktrees, review and test changes, then push to GitHub before
VPS deployment. Keep credentials, personalized images and private backups out of Git.
Build outputs are kept under the ignored `artifacts/` directory.

OpenWrt supplies the networking foundation. The [PPPoE service](openwrt/PPPOE.md)
provides local subscriber accounts, profiles, address pools and rate limits.
Captive hotspot and billing integration remain additional product work;
a menu or installed package alone is not evidence that a feature has been tested.

## Supporting references

The earlier [Linux VM lab](linux/README.md) remains a migration reference and
packet-test client, not a second router platform to develop. Its tools are in
`tools/linux/`.

`reports/radius-api-inventory.json` preserves the historical dashboard command
inventory. Despite its original filename, it does not add a RADIUS dependency.
`freeisprouteros/audit.py` and `protocol.py` contain the associated host-side
research utilities, not an implemented router compatibility service.
