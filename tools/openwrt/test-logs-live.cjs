/* Actual LuCI + logd browser test. Credentials come only from an ignored private file.
 * FREEISP_LOG_TEST_RUNTIME points to test-logs-vm.py's runtime.json.
 * This writes a diagnostic event to the disposable test router, never production.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const runtime = JSON.parse(fs.readFileSync(process.env.FREEISP_LOG_TEST_RUNTIME || 'artifacts/tests/logs-vm/runtime.json'));
const out = path.resolve('artifacts/tests/logs-vm');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    let page;
    try {
        // LuCI's unauthenticated login can report a denied system UCI read.
        // Measure the stock page first, rather than hiding unexpected feature errors.
        const stockLogin = await browser.newPage();
        const stockLoginErrors = [];
        stockLogin.on('pageerror', error => stockLoginErrors.push(error.message));
        await stockLogin.goto(runtime.url + '/cgi-bin/luci/admin/status/syslog', {timeout: 90000});
        await stockLogin.getByRole('button', {name: 'Log in', exact: true}).waitFor();
        await stockLogin.waitForTimeout(300);
        await stockLogin.close();
        page = await browser.newPage({viewport: {width: 1440, height: 1000}});
        let phase = 'login';
        const errors = []; page.on('pageerror', error => errors.push({phase, message: error.message}));
        await page.goto(runtime.url + '/cgi-bin/luci/admin/status/freeisp_log', {timeout: 90000});
        await page.locator('input[name=luci_username]').fill(runtime.username);
        await page.locator('input[name=luci_password]').fill(runtime.password);
        await page.getByRole('button', {name: 'Log in', exact: true}).click();
        await page.getByRole('heading', {name: 'Log', exact: true}).waitFor({timeout: 90000});
        phase = 'logs';
        await page.waitForFunction(() => document.querySelectorAll('.fi-log tbody tr[data-severity]').length > 0, null, {timeout: 90000});
        const search = page.getByRole('searchbox', {name: 'Search logs'});
        await search.fill(runtime.marker);
        assert.equal(await page.locator('.fi-log tbody tr[data-severity]').count(), 1, 'Actual event must reach the actual LuCI view');
        assert.match(await page.locator('.fi-log tbody').innerText(), /daemon, info/);
        await page.getByLabel('Follow latest').uncheck();
        await page.getByLabel('Severity', {exact: true}).selectOption('info');
        await page.reload();
        await page.getByRole('heading', {name: 'Log', exact: true}).waitFor({timeout: 90000});
        assert.equal(await page.getByLabel('Severity', {exact: true}).inputValue(), 'info');
        assert.equal(await page.getByLabel('Follow latest').isChecked(), false);
        await search.fill(runtime.marker);
        await page.waitForFunction(() => document.querySelectorAll('.fi-log tbody tr[data-severity]').length === 1);
        await page.getByRole('button', {name: 'Freeze', exact: true}).click();
        assert.match(await page.getByRole('status').innerText(), /Frozen/);
        await page.getByRole('button', {name: 'Resume', exact: true}).click();
        // Force network failure at the transport, keeping the genuine LuCI RPC stack.
        await page.route('**/ubus/**', route => route.abort());
        await page.route('**/ubus', route => route.abort());
        await page.getByRole('button', {name: 'Refresh', exact: true}).click();
        await page.getByRole('alert').waitFor({timeout: 60000});
        assert.match(await page.getByRole('alert').innerText(), /last successful snapshot/);
        assert.equal(await page.locator('.fi-log tbody tr[data-severity]').count(), 1);
        await page.unroute('**/ubus/**'); await page.unroute('**/ubus');
        await page.getByRole('button', {name: 'Refresh', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.fi-log-error').hidden);
        await search.fill(''); await page.getByLabel('Severity', {exact: true}).selectOption('');
        await page.screenshot({path: path.join(out, 'actual-router-log.png'), fullPage: true});
        await page.getByRole('button', {name: 'Use Night theme'}).click();
        await page.screenshot({path: path.join(out, 'actual-router-log-night.png'), fullPage: true});
        // Existing router pages still load through the same sidebar and session.
        phase = 'quickset';
        await page.locator('.freeisp-sidebar a').filter({hasText: /^Quick Set$/}).click();
        await page.locator('#qs-lanIP').waitFor({timeout: 60000});
        assert.equal(await page.locator('#qs-lanIP').inputValue(), '10.77.0.1');
        phase = 'overview';
        await page.locator('.freeisp-sidebar a').filter({hasText: /^Overview$/}).click();
        await page.waitForFunction(() => document.querySelector('#maincontent')?.textContent.includes('System'), null, {timeout: 60000});
        const unexpected = errors.filter(error => error.phase !== 'login' || !stockLoginErrors.includes(error.message));
        assert.deepEqual(unexpected, []);
        fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify({passed: true, backend: 'actual isolated OpenWrt 25.12.5 VM', pageErrors: errors, stockLoginErrors, unexpectedPageErrors: unexpected,
            checks: ['authenticated LuCI page', 'real backend event displayed', 'preferences survive reload', 'freeze/resume', 'transport failure and recovery', 'day/night', 'Quick Set and Overview navigation']}, null, 2));
        console.log('Actual OpenWrt browser checks passed: real event, preferences, freeze, connection failure/recovery, themes, Quick Set and Overview.');
    } catch(error) {
        if (page) {
            await page.screenshot({path: path.join(out, 'browser-failure.png'), fullPage: true});
            fs.writeFileSync(path.join(out, 'browser-failure.txt'), await page.locator('body').innerText());
        }
        throw error;
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
