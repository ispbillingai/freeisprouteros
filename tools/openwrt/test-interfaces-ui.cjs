/* Requires Playwright; all router RPC calls use the local fixture, never a VPS. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const overlay = 'openwrt/files/www/luci-static/';
const dataSource = fs.readFileSync(overlay + 'resources/freeisp/interfaces-data.js', 'utf8');
const viewSource = fs.readFileSync(overlay + 'resources/view/freeisp/interfaces.js', 'utf8');
const fixtureSource = fs.readFileSync('tools/openwrt/interfaces-fixture.js', 'utf8');
const css = fs.readFileSync(overlay + 'freeisp/cascade.css', 'utf8').replace(/@import[^;]+;/, '') + fs.readFileSync(overlay + 'resources/freeisp/interfaces.css', 'utf8');
const out = path.resolve('artifacts/tests/interfaces');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 950}});
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>' + css + '\n*{box-sizing:border-box}body{margin:0}header{padding:20px}.preview-label{color:var(--fi-muted);font-size:12px}.modal{position:fixed;top:15%;left:50%;transform:translateX(-50%);width:min(640px,95vw);padding:25px;border:1px solid var(--fi-line);border-radius:8px;box-shadow:0 0 0 100vmax #0007;z-index:2000}#notifications{position:fixed;bottom:0;right:0;max-width:500px;background:var(--fi-panel)}</style></head><body class="freeisp-desktop"><header><span>Workspace / Interfaces</span><span class="preview-label">Local test preview · sample router data</span></header><main id="maincontent"></main><div id="notifications"></div></body></html>');
            await page.addScriptTag({content: fixtureSource});
            await page.evaluate(({dataSource, viewSource, options}) => window.startInterfacesFixture(dataSource, viewSource, options), {dataSource, viewSource, options});
            await page.addScriptTag({content: fs.readFileSync(overlay + 'freeisp/navigation.js', 'utf8')});
            await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
        }
        const tab = name => page.getByRole('tab', {name, exact: true}).click();
        const btn = name => page.getByRole('button', {name, exact: true});
        async function add(name = 'vlan30', vid = '30') {
            await tab('VLAN'); await btn('+ Add VLAN').click();
            await page.getByLabel('Name', {exact: true}).fill(name);
            await page.getByLabel('Parent interface').selectOption('eth0');
            await page.getByLabel('VLAN ID', {exact: true}).fill(vid);
            await btn('Save to review').click();
        }
        async function apply() { await btn('Review & apply').click(); await btn('Apply changes').click(); }
        await reset();
        assert.equal(await page.getByRole('tab').count(), 4);
        assert.equal(await page.locator('.if-table tbody tr').count(), 6);
        await page.screenshot({path: path.join(out, 'interfaces-day.png'), fullPage: true});
        await tab('Interface List'); assert.match(await page.locator('.if-table').innerText(), /10.77.0.1\/24/);
        await tab('Ethernet'); assert.equal(await page.locator('.if-table tbody tr').count(), 3);
        await page.locator('.if-table tbody tr').filter({hasText: 'eth0'}).getByRole('button', {name: 'Edit'}).click();
        await page.getByLabel('MTU', {exact: true}).fill('1400'); await btn('Save to review').click();
        assert.match(await page.locator('.if-footer').innerText(), /1 device change/);
        await btn('Discard edits').click();
        await add('vlan30', '4095'); assert.match(await page.getByRole('alert').innerText(), /1.*4094/);
        await page.getByLabel('VLAN ID', {exact: true}).fill('20'); await btn('Save to review').click(); assert.match(await page.getByRole('alert').innerText(), /already exist/);
        await page.getByLabel('VLAN ID', {exact: true}).fill('30'); await btn('Save to review').click();
        assert.equal(await page.evaluate(() => fixture.calls.length), 0, 'Editing must not write to the router');
        assert.match(await page.locator('.if-table').innerText(), /vlan30/);
        await page.getByRole('searchbox').fill('missing'); assert.match(await page.locator('.if-table').innerText(), /No matching/);
        await page.getByRole('searchbox').fill('');
        await page.screenshot({path: path.join(out, 'vlan-day.png'), fullPage: true});
        await btn('Use Night theme').click(); await page.screenshot({path: path.join(out, 'vlan-night.png'), fullPage: true});
        await page.locator('.if-table tbody tr').filter({hasText: 'vlan30'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.screenshot({path: path.join(out, 'vlan-editor.png'), fullPage: true});
        await btn('Cancel').click();
        await page.setViewportSize({width: 390, height: 844});
        await page.screenshot({path: path.join(out, 'vlan-mobile.png'), fullPage: true});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Page must fit mobile width');
        await page.setViewportSize({width: 1440, height: 950});
        await apply();
        const saved = await page.evaluate(() => ({calls: fixture.calls, sections: fixture.sections}));
        assert.deepEqual(saved.calls.at(-1), ['apply', true], 'Apply must request rollback protection');
        assert(saved.sections.some(s => s.name === 'vlan30' && s.type === '8021q' && s.ifname === 'eth0' && s.vid === '30'));
        assert.equal(saved.sections.find(s => s['.name'] === 'management').ipaddr, '10.78.0.15');
        assert.deepEqual(saved.sections.find(s => s['.name'] === 'bridge').ports, ['eth1']);
        assert(await btn('Review & apply').isDisabled(), 'A second save must be blocked while LuCI applies');
        await reset(); await add();
        await page.evaluate(() => { fixture.pending = {firewall: [['set', 'wan', 'masq', '1']]}; }); await apply();
        assert.equal(await page.evaluate(() => fixture.calls.length), 0);
        assert.match(await page.locator('#notifications').innerText(), /already pending/);
        await page.evaluate(() => { fixture.pending = {}; fixture.sections[1].proto = 'static'; }); await apply();
        assert.equal(await page.evaluate(() => fixture.calls.length), 0);
        assert.match(await page.locator('#notifications').innerText(), /changed since/);
        await reset(); await add(); await page.evaluate(() => { fixture.saveFailure = true; }); await apply();
        assert.match(await page.locator('#notifications').innerText(), /did not finish/);
        assert(await btn('Review & apply').isDisabled());
        assert(!(await page.evaluate(() => fixture.calls)).some(c => c[0] === 'apply'));
        await reset(); await tab('VLAN');
        await page.locator('.if-table tbody tr').filter({hasText: 'vlan20'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('VLAN ID', {exact: true}).fill('21'); await btn('Save to review').click(); await apply();
        assert.equal(await page.evaluate(() => fixture.sections.find(s => s.name === 'vlan20').vid), '21');
        assert.deepEqual(await page.evaluate(() => fixture.sections.find(s => s.name === 'vlan20').ingress_qos_mapping), ['0:1']);
        await reset(); await tab('VLAN'); await btn('Remove').click(); await btn('Remove VLAN').click(); await apply();
        assert(!(await page.evaluate(() => fixture.sections)).some(s => s.name === 'vlan20'));
        await reset({readonly: true}); await tab('VLAN'); assert(await btn('+ Add VLAN').isDisabled()); assert(await btn('Edit').isDisabled());
        await page.evaluate(async () => { fixture.rpcFailure = true; await fixture.polls[0](); });
        assert.match(await page.locator('.if-heading').innerText(), /Connection lost/);
        assert.deepEqual(errors, []);
        console.log('Interfaces browser checks passed: all tabs, validation, add/edit/delete, Ethernet, discard, review, scoped save, rollback flag, concurrent changes, save failure, readonly, offline, Day/Night and mobile.');
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({passed: true, router: 'local mocked RPC only', pageErrors: errors}, null, 2));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
