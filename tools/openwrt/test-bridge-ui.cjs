/* Real Chromium runs the production view against a failure-injectable UCI/RPC fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = 'openwrt/files/www/luci-static/';
const dataSource = fs.readFileSync(root + 'resources/freeisp/bridge-data.js', 'utf8');
const viewSource = fs.readFileSync(root + 'resources/view/freeisp/bridge.js', 'utf8');
const fixtureSource = fs.readFileSync('tools/openwrt/bridge-fixture.js', 'utf8');
const css = fs.readFileSync(root + 'freeisp/cascade.css', 'utf8').replace(/@import[^;]+;/, '') + fs.readFileSync(root + 'resources/freeisp/bridge.css', 'utf8');
const out = path.resolve('artifacts/tests/bridge');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    const checks = [];
    try {
        const page = await browser.newPage({viewport: {width: 1580, height: 960}}), errors = [];
        page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>' + css + '*{box-sizing:border-box}body{margin:0}header{padding:20px}.modal{position:fixed;top:5%;left:50%;transform:translateX(-50%);width:min(720px,95vw);padding:25px;border:1px solid var(--fi-line);border-radius:8px;box-shadow:0 0 0 100vmax #0007;z-index:2000}#notifications{position:fixed;bottom:0;right:0;max-width:550px;background:var(--fi-panel);z-index:2500}</style></head><body class="freeisp-desktop"><header><span>Workspace / Bridge</span><span>Local test preview · sample router data</span></header><main id="maincontent"></main><div id="notifications"></div></body></html>');
            await page.addScriptTag({content: fixtureSource});
            await page.evaluate(({dataSource, viewSource, options}) => startBridgeFixture(dataSource, viewSource, options), {dataSource, viewSource, options});
            await page.addScriptTag({content: fs.readFileSync(root + 'freeisp/navigation.js', 'utf8')});
            await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
        }
        const btn = name => page.getByRole('button', {name, exact: true});
        const tab = name => page.getByRole('tab', {name, exact: true}).click();
        const record = name => { checks.push(name); console.log('PASS ' + name); };
        async function addBridge(name = 'br-test') {
            await tab('Bridge'); await btn('+ Add bridge').click(); await page.getByLabel('Bridge name', {exact: true}).fill(name); await btn('Save to review').click();
        }
        async function apply() { await btn('Review & apply').click(); await btn('Apply with rollback').click(); }
        await reset();
        assert.equal(await page.getByRole('tab').count(), 4);
        assert.match(await page.locator('.br-table').innerText(), /br-lan/);
        await page.screenshot({path: path.join(out, 'bridge-day.png'), fullPage: true});
        await btn('+ Add bridge').click(); await page.getByLabel('Bridge name', {exact: true}).fill('bad name'); await btn('Save to review').click();
        assert.match(await page.locator('.br-error').innerText(), /1–15/); await btn('Cancel').click();
        await addBridge(); assert.equal(await page.evaluate(() => fixture.calls.length), 0);
        assert.match(await page.locator('.br-footer').innerText(), /1 configuration/);
        await tab('Ports'); await btn('+ Add port').click(); await page.getByLabel('Bridge', {exact: true}).selectOption('br-test'); await page.getByLabel('Port', {exact: true}).selectOption('eth0'); await btn('Save to review').click();
        assert.match(await page.locator('.br-error').innerText(), /used directly/);
        await page.getByLabel('Port', {exact: true}).selectOption('eth3'); await btn('Save to review').click();
        assert.match(await page.locator('.br-table').innerText(), /eth3/);
        await page.locator('.br-table tbody tr').filter({hasText: 'eth3'}).getByRole('button', {name: 'Settings'}).click();
        await page.getByLabel('Port isolation', {exact: true}).selectOption('1'); await btn('Save to review').click();
        await tab('VLANs'); await page.getByLabel('Filter by bridge').selectOption('br-test'); await btn('+ Add VLAN').click();
        await page.getByLabel('VLAN ID', {exact: true}).fill('4095'); await btn('Save to review').click(); assert.match(await page.locator('.br-error').innerText(), /4094/);
        await page.getByLabel('VLAN ID', {exact: true}).fill('20'); await page.getByLabel('eth3', {exact: true}).selectOption('u*'); await btn('Save to review').click();
        await apply();
        assert.deepEqual(await page.evaluate(() => fixture.calls.slice(-3)), ['save', 'changes.init', 'apply:true']);
        assert.equal(await page.evaluate(() => fixture.saved().find(s => s.name === 'br-test').ports[0]), 'eth3');
        assert.equal(await page.evaluate(() => fixture.saved().find(s => s.name === 'eth3').isolate), '1');
        assert.deepEqual(await page.evaluate(() => fixture.saved().find(s => s.device === 'br-test').ports), ['eth3:u*']);
        await page.evaluate(() => fixture.reload()); await tab('VLANs'); assert.match(await page.locator('.br-table').innerText(), /br-test/);
        record('Create bridge, attach port, set isolation, add PVID VLAN, apply with rollback and reload persisted fixture configuration');
        await reset(); await tab('Ports'); await page.locator('.br-table tbody tr').filter({hasText: 'eth1'}).getByRole('button', {name: 'Detach'}).click(); assert.match(await page.locator('#notifications').innerText(), /VLANs 10/);
        await tab('VLANs'); await btn('Remove').click(); assert.match(await page.locator('#notifications').innerText(), /referenced by lan/);
        await tab('Bridge'); await btn('Remove').click(); assert.match(await page.locator('#notifications').innerText(), /references/);
        record('Referenced bridge, port and VLAN removal is blocked');
        await reset(); await addBridge();
        await page.locator('.br-table tbody tr').filter({hasText: 'br-test'}).getByRole('button', {name: 'Settings'}).click();
        await page.getByLabel('MTU', {exact: true}).fill('1420'); await btn('Save to review').click();
        await tab('Ports'); await btn('+ Add port').click(); await page.getByLabel('Bridge', {exact: true}).selectOption('br-test'); await page.getByLabel('Port', {exact: true}).selectOption('eth3'); await btn('Save to review').click();
        await apply(); assert.equal(await page.evaluate(() => fixture.saved().find(s => s.name === 'br-test').mtu), '1420');
        await page.evaluate(() => fixture.reload()); await tab('Ports');
        await page.locator('.br-table tbody tr').filter({hasText: 'eth3'}).getByRole('button', {name: 'Detach'}).click(); await btn('Remove from draft').click();
        await tab('Bridge'); await page.locator('.br-table tbody tr').filter({hasText: 'br-test'}).getByRole('button', {name: 'Remove'}).click(); await btn('Remove from draft').click();
        await apply(); assert.equal(await page.evaluate(() => fixture.saved().some(s => s.name === 'br-test')), false);
        assert.equal(await page.evaluate(() => fixture.saved().find(s => s['.name'] === 'lan').device), 'br-lan.10');
        record('Edit MTU, save, detach and remove a bridge without changing existing LAN configuration');
        await reset(); await addBridge(); await btn('Discard edits').click(); assert.doesNotMatch(await page.locator('.br-table').innerText(), /br-test/); assert.equal(await page.evaluate(() => fixture.calls.length), 0);
        record('Discard does not write to the backend');
        for (const [mode, message] of [['pending', /pending changes/], ['changed', /changed on another page/], ['saveFailure', /did not finish/], ['applyFailure', /did not finish/]]) {
            await reset({[mode]: true}); await addBridge(); await apply();
            assert.match(await page.locator('#notifications').innerText(), message);
            const calls = await page.evaluate(() => fixture.calls);
            if (mode === 'pending' || mode === 'changed') assert(!calls.includes('save'));
            if (mode === 'saveFailure') assert(!calls.includes('apply:true'));
            record('Apply failure handling: ' + mode);
        }
        await reset(); await page.evaluate(async () => { fixture.options.statusFailure = true; await fixture.polls[0](); }); assert.match(await page.locator('.br-warnings').innerText(), /Refresh failed/);
        assert.match(await page.locator('.br-table').innerText(), /Stale/);
        await page.evaluate(async () => { fixture.options.statusFailure = false; await fixture.polls[0](); }); assert.equal(await page.locator('.br-warnings').innerText(), '');
        await page.getByRole('searchbox').fill('br-lan'); await page.evaluate(() => fixture.polls[0]()); assert.equal(await page.getByRole('searchbox').evaluate(n => n === document.activeElement), true);
        record('Polling failure, recovery and focused search preservation');
        await reset({telemetryFailure: true}); await tab('Hosts'); assert.match(await page.locator('.br-table').innerText(), /unavailable/); assert.match(await page.locator('.br-warnings').innerText(), /telemetry unavailable/);
        record('Missing bridge helper reports unavailable instead of fabricated empty status');
        await reset({readonly: true}); assert.equal(await btn('+ Add bridge').isDisabled(), true); await tab('Ports'); assert.equal(await btn('+ Add port').isDisabled(), true);
        record('Read-only accounts cannot mutate configuration');
        await reset({hostCount: 205}); await tab('Hosts'); assert.equal(await page.locator('.br-table tbody tr').count(), 100);
        await btn('Next').click(); assert.match(await page.locator('.br-pagination').innerText(), /Page 2 of 3/);
        await page.getByLabel('Host entry type').selectOption('Local'); assert.equal(await page.locator('.br-table tbody tr').count(), 1);
        await page.getByLabel('Host entry type').selectOption(''); await page.getByRole('searchbox').fill('02:11:22:33:00:cc'); assert.equal(await page.locator('.br-table tbody tr').count(), 1);
        const downloadPromise = page.waitForEvent('download'); await btn('Export CSV').click(); const download = await downloadPromise;
        await download.saveAs(path.join(out, 'hosts.csv')); assert.match(fs.readFileSync(path.join(out, 'hosts.csv'), 'utf8'), /02:11:22:33:00:cc/);
        record('FDB pagination, type filter, search and actual CSV download');
        await page.getByRole('searchbox').fill(''); await page.getByRole('button', {name: 'Use Night theme'}).click(); await page.screenshot({path: path.join(out, 'hosts-night.png'), fullPage: true});
        await page.setViewportSize({width: 550, height: 850}); await page.screenshot({path: path.join(out, 'bridge-mobile.png'), fullPage: true});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
        record('Day/night, narrow viewport and no browser exceptions');
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({passed: true, checks, scope: 'Chromium with simulated UCI/RPC; not live router verification'}, null, 2));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
