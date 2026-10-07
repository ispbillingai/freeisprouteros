const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const overlay = 'openwrt/files/www/luci-static/';
const dataSource = fs.readFileSync(overlay + 'resources/freeisp/log-data.js', 'utf8');
const viewSource = fs.readFileSync(overlay + 'resources/view/freeisp/log.js', 'utf8');
const css = fs.readFileSync(overlay + 'freeisp/cascade.css', 'utf8').replace(/@import[^;]+;/, '') + fs.readFileSync(overlay + 'resources/freeisp/log.css', 'utf8');
const out = path.resolve('artifacts/tests/logs'); fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 950}});
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body><main id="maincontent"></main></body></html>'}));
        async function reset(options = {}) {
            await page.goto('http://freeisp.test/');
            await page.addStyleTag({content: css});
            await page.evaluate(({dataSource, viewSource, options}) => {
                if (!options.persist) localStorage.clear();
                window.fixture = {calls: [], fail: options.fail, delay: false, polls: [], reply: {log: [
                    {id: 10, priority: 30, time: 1791360000123, msg: 'dnsmasq-dhcp[51]: DHCPACK(br-lan) 10.77.0.100 client'},
                    {id: 11, priority: 4, time: 1791360001123, msg: '[ 12.4] eth0: link down'},
                    {id: 12, priority: 35, time: 1791360002123, msg: 'dropbear[99]: Failed login'},
                    {id: 13, priority: 14, time: 1791360003123, msg: '<img src=x onerror="window.injected=true">'}
                ]}};
                window.E = function(tag, attrs = {}, children = []) {
                    const node = document.createElement(tag);
                    Object.entries(attrs).forEach(([key, value]) => typeof value === 'function' ? node.addEventListener(key, value) : node.setAttribute(key, value));
                    const append = value => { if (Array.isArray(value)) value.forEach(append); else if (value != null) node.append(value instanceof Node ? value : document.createTextNode(String(value))); };
                    append(children); return node;
                };
                const data = new Function('baseclass', dataSource)({extend: x => x});
                const rpc = {declare: declaration => {
                    fixture.declaration = declaration;
                    return async (...args) => {
                        fixture.calls.push(args);
                        if (fixture.delay) await new Promise(resolve => { fixture.release = resolve; });
                        if (fixture.fail) throw new Error('Permission denied or disconnected');
                        return structuredClone(fixture.reply);
                    };
                }};
                const poll = {add: (fn, interval) => { fixture.polls.push(fn); fixture.interval = interval; }};
                const view = new Function('view', 'rpc', 'poll', 'data', 'E', 'L', viewSource)({extend: x => x}, rpc, poll, data, E, {resource: x => '/resources/' + x});
                document.querySelector('main').append(view.render());
            }, {dataSource, viewSource, options});
            await page.waitForFunction(() => fixture.calls.length && !document.querySelector('[role=status]').textContent.includes('Refreshing'));
        }
        const btn = name => page.getByRole('button', {name, exact: true});
        const rows = () => page.locator('tbody tr[data-severity]');
        const poll = () => page.evaluate(() => fixture.polls[0]());
        await reset();
        assert.equal(await rows().count(), 4);
        assert.deepEqual(await page.evaluate(() => fixture.calls[0]), [1000, false, true]);
        assert.equal(await page.evaluate(() => fixture.declaration.reject), true);
        assert.equal(await page.evaluate(() => fixture.interval), 5);
        assert.equal(await page.locator('tbody img').count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.getByRole('searchbox').fill('DHCPACK'); assert.equal(await rows().count(), 1);
        const downloaded = page.waitForEvent('download'); await btn('Download visible logs').click();
        const download = await downloaded; await download.saveAs(path.join(out, 'filtered.txt'));
        assert.match(fs.readFileSync(path.join(out, 'filtered.txt'), 'utf8'), /DHCPACK/);
        assert.doesNotMatch(fs.readFileSync(path.join(out, 'filtered.txt'), 'utf8'), /Failed login/);
        await page.getByRole('searchbox').fill('['); assert.equal(await rows().count(), 3);
        await page.getByRole('searchbox').fill('missing'); assert.match(await page.locator('tbody').innerText(), /No matching/);
        await page.getByRole('searchbox').fill('');
        await page.getByLabel('Severity', {exact: true}).selectOption('warn'); assert.equal(await rows().count(), 1);
        await page.getByLabel('Follow latest').uncheck();
        await reset({persist: true}); assert.equal(await rows().count(), 1); assert.equal(await page.getByLabel('Follow latest').isChecked(), false);
        await page.getByLabel('Severity', {exact: true}).selectOption('');
        await page.getByLabel('Facility', {exact: true}).selectOption('kern'); assert.equal(await rows().count(), 1);
        await poll(); assert.equal(await page.getByLabel('Facility', {exact: true}).inputValue(), 'kern');
        await page.getByLabel('Facility', {exact: true}).selectOption('');
        await btn('Freeze').click(); const calls = await page.evaluate(() => fixture.calls.length);
        await page.evaluate(() => fixture.reply.log.push({id: 14, time: 1791360010000, priority: 30, msg: 'new event'}));
        await poll(); assert.equal(await page.evaluate(() => fixture.calls.length), calls); assert.equal(await rows().count(), 4);
        await btn('Resume').click(); await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-severity]').length === 5);
        await page.evaluate(() => { fixture.delay = true; fixture.polls[0](); });
        await btn('Freeze').click();
        await page.evaluate(() => { fixture.reply.log.push({id: 15, time: 1791360011000, priority: 30, msg: 'late event'}); fixture.delay = false; fixture.release(); });
        await page.waitForFunction(() => document.querySelector('[role=status]').textContent.startsWith('Frozen'));
        assert.equal(await rows().count(), 5, 'Late refresh must not alter frozen rows');
        await btn('Resume').click(); await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-severity]').length === 6);
        await page.evaluate(() => { fixture.delay = true; fixture.polls[0](); });
        await btn('Freeze').click(); await btn('Resume').click();
        const beforeResume = await page.evaluate(() => fixture.calls.length);
        await page.evaluate(() => { fixture.delay = false; fixture.release(); });
        await page.waitForFunction(n => fixture.calls.length === n + 1 && !document.querySelector('[role=status]').textContent.includes('Refreshing'), beforeResume);
        // Buffer rotation/reboot must replace a snapshot, rather than duplicate old entries.
        await page.evaluate(() => { fixture.reply.log = [{id: 0, time: 1791360012000, priority: 30, msg: 'after reboot'}]; }); await poll();
        assert.equal(await rows().count(), 1); assert.match(await page.locator('tbody').innerText(), /after reboot/);
        await page.evaluate(() => { fixture.fail = true; }); await poll();
        assert.match(await page.getByRole('alert').innerText(), /last successful snapshot/); assert.equal(await rows().count(), 1);
        await page.evaluate(() => { fixture.fail = false; fixture.reply = {}; }); await poll();
        assert.match(await page.getByRole('alert').innerText(), /invalid log response/); assert.equal(await rows().count(), 1);
        await page.evaluate(() => { fixture.reply = {log: []}; }); await poll();
        assert.match(await page.locator('tbody').innerText(), /buffer is empty/); assert.equal(await page.getByRole('alert').isVisible(), false);
        await reset({fail: true}); assert.match(await page.locator('tbody').innerText(), /unavailable/);
        await page.evaluate(() => { fixture.fail = false; }); await btn('Refresh').click();
        await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-severity]').length === 4);
        await page.screenshot({path: path.join(out, 'logs-day.png'), fullPage: true});
        await page.evaluate(() => { document.documentElement.dataset.freeispTheme = 'night'; });
        await page.screenshot({path: path.join(out, 'logs-night.png'), fullPage: true});
        await page.setViewportSize({width: 390, height: 844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page must not overflow');
        await page.screenshot({path: path.join(out, 'logs-mobile.png'), fullPage: true});
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({passed: true, backend: 'simulated logd RPC; not a live router', pageErrors: errors}, null, 2));
        console.log('Log browser checks passed: read contract, rendering, injection, filters, export, preferences across reload, polling, freeze/resume race, failure, stale data, recovery, empty buffer, day/night and mobile.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
