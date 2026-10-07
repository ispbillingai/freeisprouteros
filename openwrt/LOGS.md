# FreeISP Log

The sidebar Log entry opens `/cgi-bin/luci/admin/status/freeisp_log`. The page
reads OpenWrt 25.12's real `log.read` ubus endpoint with
`{"lines":1000,"stream":false,"oneshot":true}` every five seconds. It has its
own read-only ACL (`luci-app-freeisp-log`); no command execution or configuration
write permission is required. The original OpenWrt system log page remains available.

The table shows the logd event ID, UTC timestamp, memory buffer, syslog facility,
severity, process tag when present, and full message. Facility/severity values
come from the event priority, not guesses based on message text. Kernel events
in the system buffer have the `kern` facility. This does not claim to show the
entire separate kernel ring buffer.

Freeze holds the current snapshot, including when a request is already in flight.
Resume immediately requests a fresh snapshot. Search is case-insensitive literal
text; severity and facility filters combine with it. Download exports the visible
entries as plain text. Follow latest controls scrolling. Severity and Follow latest
preferences survive reloads in the same browser/router origin; search, facility
and Freeze reset on a new page. There are no router settings to save.

A failed request retains the last successful snapshot and visibly reports the
failure. Initial failure, an empty buffer and no filter matches are distinct states.
Entries are replaced on each successful snapshot, so rotation or reboot does not
accumulate duplicates. Logs are volatile: older events rotate out and reboot clears
the memory buffer. This feature does not configure persistent storage or remote syslog.

## Tests

Run from the repository root:

```
node tools/openwrt/test-logs.cjs
node tools/openwrt/test-quickset.cjs
npm install --no-save --package-lock=false playwright@1.57.0
npx playwright install chromium
node tools/openwrt/test-logs-ui.cjs
```

The browser regression test uses simulated logd replies and exercises display,
filters, export, persistent display preferences, Freeze/Resume races, buffer
rotation, malformed replies, connection failure/recovery, HTML-looking messages,
day/night and mobile layout. It is not evidence of a real router connection.

For a real disposable OpenWrt guest, use Linux with QEMU, Python, OpenSSL and root
mount permissions. Supply a private FreeISP OpenWrt 25.12.5 ext4 VM image:

```
python3 tools/openwrt/test-logs-vm.py --image /private/freeisp-openwrt.img.gz --hold
```

The harness copies the image, installs this checkout's UI/menu/ACL overlay, supplies a random test
password, boots three isolated guest NICs, and checks real log reads, a newly
generated logger event, invalid login, anonymous rejection and read-only permissions.
The source image and deployed router are unchanged. While it is running, execute
`node tools/openwrt/test-logs-live.cjs` from a machine that can reach the VM's
loopback port 18890. Set `FREEISP_LOG_TEST_RUNTIME` if its private runtime.json is
elsewhere. This browser test uses actual LuCI and logd, checks failure/recovery and
preferences, and checks navigation to existing Quick Set and Overview pages.

Outputs and temporary credentials are under ignored `artifacts/tests/logs-vm/`.
Create its `STOP` file to end a held test; the VM and copied disk are cleaned up.
Remove an old STOP file before repeating a held run. Do not publish VM disks,
runtime credentials or real customer logs. The CI workflow runs the simulated
tests; the private-image VM test is an explicit local integration test.

FreeISP Desk needs no native change: it loads this authenticated router page after
connecting. Its local Device Hub remains offline-capable. Run a released Desk
executable with `--self-test` in a separate test directory to verify the actual
Windows hub with external web requests blocked.

API references: [LuCI log reader](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-base/htdocs/luci-static/resources/tools/views.js),
[logd source](https://github.com/openwrt/ubox/blob/master/log/logd.c).

## Verified on 2026-10-07

- Data and simulated browser regressions passed, including late-response Freeze
  handling, Resume during an outstanding request, and buffer replacement after reboot.
- An isolated OpenWrt 25.12.5 VM passed real log reads, logger event detection,
  anonymous/invalid login rejection, and limited-account read/config-write permissions.
- Its actual LuCI page passed real-event rendering, preference reloads, Freeze/Resume,
  forced transport failure with retained results, recovery and day/night rendering.
  Existing Quick Set loaded the expected LAN IP, and Overview loaded system status.
- FreeISP Desk v0.2.2 passed its native Windows `--self-test`, including bundled
  hub rendering, WebView bridge and logo, with external web requests blocked.
- Existing Quick Set validation, JavaScript syntax, overlay JSON, Python compilation
  and shell syntax with Linux line endings passed.

The real browser test records a denied unauthenticated `uci/get` console warning
also reproduced on the stock LuCI System Log login page. There were no new errors
after authentication. This feature does not change that upstream login behavior.
The VPS was not deployed or tested through its unavailable tunnel. These checks do
not certify all routing protocols, physical hardware, or disk/remote log persistence.
