/* Requires Playwright. All router responses are local fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const overlay = 'openwrt/files/www/luci-static/';
const dataSource = fs.readFileSync(overlay + 'resources/freeisp/queues-data.js', 'utf8');
const viewSource = fs.readFileSync(overlay + 'resources/view/freeisp/queues.js', 'utf8');
const fixture = fs.readFileSync('tools/openwrt/queues-fixture.js', 'utf8');
const css = fs.readFileSync(overlay + 'freeisp/cascade.css', 'utf8').replace(/@import[^;]+;/, '') + fs.readFileSync(overlay + 'resources/freeisp/queues.css', 'utf8');
const out = path.resolve('artifacts/tests/queues');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 950}}), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>' + css + '*{box-sizing:border-box}body{margin:0}header{padding:20px}.modal{position:fixed;top:5%;left:50%;transform:translateX(-50%);width:min(640px,95vw);padding:25px;background:var(--fi-panel,#fff);border:1px solid var(--fi-line);border-radius:8px;box-shadow:0 0 0 100vmax #0007;z-index:2000}</style></head><body class="freeisp-desktop"><header>Workspace / Queues · Local preview with sample data</header><main id="maincontent"></main><div id="notifications"></div></body></html>');
            await page.addScriptTag({content: fixture});
            await page.evaluate(({dataSource, viewSource, options}) => startQueuesFixture(dataSource, viewSource, options), {dataSource, viewSource, options});
            await page.addScriptTag({content: fs.readFileSync(overlay + 'freeisp/navigation.js', 'utf8')});
            await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
        }
        const tab = name => page.getByRole('tab', {name, exact: true});
        const table = page.locator('.if-table');
        const refresh = () => page.getByRole('button', {name: 'Refresh', exact: true}).click();
        await reset();
        assert.equal(await page.getByRole('tab').count(), 4);
        assert.match(await table.innerText(), /Per-subscriber.*not available/);
        assert(await page.getByRole('searchbox').isDisabled());
        assert(!(await page.getByRole('button', {name: '+ Add queue', exact: true}).isVisible()));
        assert.equal(await page.getByRole('link', {name: 'Open SQM settings'}).getAttribute('href'), '/cgi-bin/luci/admin/network/sqm');
        await page.screenshot({path: path.join(out, 'simple-queues-day.png'), fullPage: true});
        await tab('Simple Queues').focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await tab('Interface Queues').getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('.if-table tbody tr').count(), 2);
        assert.match(await table.innerText(), /10 Mbps/); assert.match(await table.innerText(), /50 Mbps/);
        assert.match(await table.innerText(), /Shaping off/); assert.doesNotMatch(await table.innerText(), /Running/);
        await page.getByRole('searchbox').fill('backup'); assert.equal(await page.locator('.if-table tbody tr').count(), 1);
        await page.getByRole('searchbox').fill('missing'); assert.match(await table.innerText(), /No matching/);
        await page.getByRole('searchbox').fill('');
        await page.screenshot({path: path.join(out, 'interface-queues-day.png'), fullPage: true});
        await page.getByRole('button', {name: 'Use Night theme', exact: true}).click();
        await page.screenshot({path: path.join(out, 'interface-queues-night.png'), fullPage: true});
        await page.setViewportSize({width: 390, height: 844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page must fit a phone');
        await page.screenshot({path: path.join(out, 'queues-mobile.png'), fullPage: true});
        await page.setViewportSize({width: 1440, height: 950});
        await tab('Queue Tree').click(); assert.match(await table.innerText(), /not available/);
        await tab('Queue Types').click(); assert.match(await table.innerText(), /fq_codel/); assert.match(await table.innerText(), /Not reported by SQM/);
        await tab('Queue Types').focus(); await page.keyboard.press('Home'); assert.equal(await tab('Simple Queues').getAttribute('aria-selected'), 'true');
        await page.keyboard.press('End'); assert.equal(await tab('Queue Types').getAttribute('aria-selected'), 'true');
        await page.evaluate(() => { fixture.values.wan.upload = '25000'; fixture.changes = [['set', 'wan', 'upload', '25000']]; });
        await refresh(); await tab('Interface Queues').click(); assert.match(await table.innerText(), /25 Mbps/);
        assert.match(await page.locator('#queues-panel').innerText(), /Pending SQM changes/);
        await page.evaluate(() => { fixture.failures = ['get', 'list', 'changes']; });
        await refresh(); assert.match(await table.innerText(), /Cannot read SQM/); assert.doesNotMatch(await table.innerText(), /25 Mbps/);
        await tab('Queue Types').click(); assert.match(await table.innerText(), /inventory unavailable/);
        await page.evaluate(() => { fixture.failures = []; fixture.values = {}; fixture.inventory = []; fixture.changes = []; });
        await refresh(); assert.match(await table.innerText(), /No queue types/);
        await tab('Interface Queues').click(); assert.match(await table.innerText(), /No interface queues/);
        await reset({failures: ['list', 'changes']}); await tab('Queue Types').click();
        assert.match(await table.innerText(), /Unknown/); assert.match(await table.innerText(), /cake/);
        assert.match(await page.locator('#queues-panel').innerText(), /Pending changes could not be checked/);
        await reset({values: {'<img src=x onerror=alert(1)>': {'.type': 'queue', interface: '<script>bad</script>'}}});
        await tab('Interface Queues').click(); assert.equal(await table.locator('img, script').count(), 0); assert.match(await table.innerText(), /<script>/);
        const button = name => page.getByRole('button', {name, exact: true});
        async function add(name = 'guest') {
            await tab('Interface Queues').click(); await button('+ Add queue').click();
            await page.getByLabel('Name', {exact: true}).fill(name);
            await page.getByLabel('Interface', {exact: true}).selectOption('eth2');
        }
        async function apply() { await button('Review & apply').click(); await button('Apply changes').click(); }
        await reset(); await add();
        await page.getByLabel('Upload (kbit/s)', {exact: true}).fill('-10'); await button('Save to review').click();
        assert.match(await page.getByRole('alert').innerText(), /whole kbit/);
        await page.getByLabel('Upload (kbit/s)', {exact: true}).fill('20000');
        await page.getByLabel('Interface', {exact: true}).selectOption('eth0'); await button('Save to review').click();
        assert.match(await page.getByRole('alert').innerText(), /already uses/);
        await page.getByLabel('Interface', {exact: true}).selectOption('eth2'); await button('Save to review').click();
        assert(!(await page.evaluate(() => fixture.calls)).some(c => ['add', 'set', 'save'].includes(c[0])));
        assert(await button('Refresh').isDisabled());
        await apply();
        assert.equal(await page.evaluate(() => fixture.values.guest.upload), '20000');
        assert.deepEqual((await page.evaluate(() => fixture.calls)).at(-1), ['apply', true]);
        assert(await button('Review & apply').isDisabled());
        await reset(); await tab('Interface Queues').click();
        await page.locator('.if-table tbody tr').filter({hasText: 'wan'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('Configuration', {exact: true}).selectOption('0'); await button('Save to review').click(); await apply();
        assert.equal(await page.evaluate(() => fixture.values.wan.enabled), '0');
        await reset(); await tab('Interface Queues').click();
        await page.locator('.if-table tbody tr').filter({hasText: 'backup'}).getByRole('button', {name: 'Remove', exact: true}).click();
        await button('Remove queue').click(); await apply(); assert.equal(await page.evaluate(() => fixture.values.backup), undefined);
        await reset(); await add(); await button('Save to review').click(); await button('Discard edits').click();
        assert.equal(await page.locator('.if-table tbody tr').count(), 2);
        for (const failure of ['pending', 'concurrent', 'save', 'enable']) {
            await reset(); await add(); await button('Save to review').click();
            await page.evaluate(failure => {
                if (failure === 'pending') fixture.pending = {firewall: [['set', 'x', 'y', 'z']]};
                else if (failure === 'concurrent') fixture.values.wan.upload = '42';
                else fixture.failures.push(failure);
            }, failure);
            await apply();
            assert.match(await page.locator('#notifications').innerText(), failure === 'pending' ? /pending changes/ : failure === 'concurrent' ? /changed since/ : /did not complete/);
            assert(!(await page.evaluate(() => fixture.calls)).some(c => c[0] === 'apply'));
        }
        await reset({readonly: true}); await tab('Interface Queues').click(); assert(await button('+ Add queue').isDisabled());
        assert(await page.getByRole('button', {name: 'Edit', exact: true}).first().isDisabled());
        await page.evaluate(async () => { fixture.failures.push('runtime'); await fixture.polls[0](); });
        assert.match(await table.innerText(), /Unknown/); assert.doesNotMatch(await table.innerText(), /12345/);
        assert.deepEqual(errors, []);
        console.log('Queue browser checks passed: tabs, keyboard, filtering, refresh, pending changes, missing inventory, failure recovery, safe text, Day/Night, mobile and scoped edits. Mocked router RPC only.');
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({passed: true, router: 'local mocked RPC only', pageErrors: errors}, null, 2));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
