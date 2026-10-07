/* Destructive test of SQM configuration: run ONLY against a disposable local VM.
 * FREEISP_QUEUE_TEST_URL, FREEISP_QUEUE_TEST_CREDENTIALS and
 * FREEISP_QUEUE_TEST_DISPOSABLE=yes are required. Never point at a shared router.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const base = process.env.FREEISP_QUEUE_TEST_URL;
assert.equal(process.env.FREEISP_QUEUE_TEST_DISPOSABLE, 'yes');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const password = JSON.parse(fs.readFileSync(process.env.FREEISP_QUEUE_TEST_CREDENTIALS)).password;
const out = path.resolve('artifacts/tests/queues-router'); fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    const checks = {}, errors = [];
    try {
        const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
        page.setDefaultTimeout(45000);
        page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
        let sid = '0'.repeat(32);
        async function rpc(object, method, args = {}, required = true, timeout = 60000) {
            const response = await page.request.post(base + '/ubus', {data: {jsonrpc: '2.0', id: 1, method: 'call', params: [sid, object, method, args]}, timeout});
            const result = (await response.json()).result;
            if (required) assert.equal(result?.[0], 0, object + '.' + method);
            return required ? result[1] || {} : result;
        }
        async function login(timeout = 60000) {
            sid = '0'.repeat(32);
            sid = (await rpc('session', 'login', {username: 'root', password}, true, timeout)).ubus_rpc_session;
            const response = await page.request.post(base + '/cgi-bin/luci/admin/freeisp', {form: {luci_username: 'root', luci_password: password}, maxRedirects: 0, timeout});
            assert.equal(response.status(), 302, 'LuCI login');
        }
        async function exec(command, params) {
            const result = await rpc('file', 'exec', {command, params}); assert.equal(result.code, 0, command + ': ' + result.stderr); return result.stdout;
        }
        async function config(name) { return (await rpc('uci', 'get', {config: name})).values; }
        async function kernel() { return JSON.parse(await exec('/sbin/tc', ['-s', '-j', 'qdisc', 'show'])); }
        async function open() {
            await page.goto(base + '/cgi-bin/luci/admin/network/freeisp_queues', {waitUntil: 'networkidle', timeout: 90000});
            await page.getByRole('tab', {name: 'Interface Queues', exact: true}).click();
        }
        function button(name) { return page.getByRole('button', {name, exact: true}); }
        function row() { return page.locator('.if-table tbody tr').filter({hasText: 'queue_test'}); }
        async function apply() {
            await button('Review & apply').click();
            const reloaded = page.waitForNavigation({waitUntil: 'networkidle', timeout: 90000});
            await button('Apply changes').click(); await reloaded;
            await page.getByRole('tab', {name: 'Interface Queues', exact: true}).waitFor({timeout: 90000});
            await page.getByRole('tab', {name: 'Interface Queues', exact: true}).click();
            await button('Review & apply').waitFor();
            assert(!(await page.locator('.if-footer').innerText()).includes('Reload required'), 'Apply must finish and reload');
        }
        await login();
        const networkBefore = await config('network');
        const sqmBefore = await config('sqm');
        assert(!sqmBefore.queue_test, 'Use a clean disposable VM');
        await open(); checks.real_page_loaded = true;
        console.log('Real queue page loaded.');
        await page.screenshot({path: path.join(out, 'initial.png'), fullPage: true});
        await button('+ Add queue').click();
        await page.getByLabel('Name', {exact: true}).fill('queue_test');
        await page.getByLabel('Interface', {exact: true}).selectOption('eth0');
        await page.getByLabel('Upload (kbit/s)', {exact: true}).fill('-1');
        await button('Save to review').click();
        assert.match(await page.getByRole('alert').innerText(), /whole kbit/);
        assert(!(await config('sqm')).queue_test); checks.invalid_rate_did_not_write = true;
        await page.getByLabel('Upload (kbit/s)', {exact: true}).fill('1000');
        await page.getByLabel('Download (kbit/s)', {exact: true}).fill('2000');
        await button('Save to review').click();
        assert(!(await config('sqm')).queue_test); checks.draft_did_not_write = true;
        await apply();
        assert.equal((await config('sqm')).queue_test.upload, '1000');
        let live = await kernel();
        assert(live.some(q => q.dev === 'eth0' && q.root && q.kind === 'cake' && q.options.bandwidth === 125000));
        assert(live.some(q => q.dev.startsWith('ifb') && q.root && q.kind === 'cake' && q.options.bandwidth === 250000));
        checks.add_applied_upload_and_download_shapers = true;
        console.log('Add applied: both kernel shapers match requested limits.');
        await page.screenshot({path: path.join(out, 'queue-active.png'), fullPage: true});
        await row().getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('Upload (kbit/s)', {exact: true}).fill('3000');
        await button('Save to review').click(); await apply();
        assert.equal((await config('sqm')).queue_test.upload, '3000');
        assert((await kernel()).some(q => q.dev === 'eth0' && q.root && q.options?.bandwidth === 375000));
        checks.edit_applied = true;
        console.log('Rate edit applied; testing reboot persistence.');
        await exec('/bin/sync', []);
        await rpc('file', 'exec', {command: '/sbin/reboot', params: []}).catch(() => {});
        let ready = false;
        const rebootDeadline = Date.now() + 180000;
        while (Date.now() < rebootDeadline) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try { await login(3000); if ((await rpc('uci', 'get', {config: 'sqm'}, true, 3000)).values.queue_test?.upload === '3000') { ready = true; break; } } catch {}
        }
        assert(ready, 'Router must return after reboot');
        await open();
        assert((await kernel()).some(q => q.dev === 'eth0' && q.root && q.options?.bandwidth === 375000));
        checks.settings_and_shaper_survived_reboot = true;
        console.log('Configuration and shaper survived reboot.');
        await row().getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('Configuration', {exact: true}).selectOption('0');
        await button('Save to review').click(); await apply();
        assert.equal((await config('sqm')).queue_test.enabled, '0');
        assert(!(await kernel()).some(q => q.dev === 'eth0' && q.root && q.kind === 'cake'));
        checks.disable_removed_shaper = true;
        console.log('Disable removed the live shaper.');
        await row().getByRole('button', {name: 'Remove', exact: true}).click();
        await button('Remove queue').click(); await apply();
        assert(!(await config('sqm')).queue_test); checks.remove_persisted = true;
        assert.deepEqual(await config('network'), networkBefore); checks.network_configuration_preserved = true;
        const after = await config('sqm');
        for (const [id, section] of Object.entries(sqmBefore)) assert.deepEqual(after[id], section);
        checks.existing_sqm_preserved = true;
        await page.route('**/ubus/**', route => route.abort());
        await page.route('**/ubus', route => route.abort());
        await button('Refresh').click();
        await page.getByText('Cannot read SQM configuration.', {exact: false}).waitFor();
        checks.connection_failure_visible = true;
        await page.unroute('**/ubus/**'); await page.unroute('**/ubus');
        await button('Refresh').click();
        await page.waitForFunction(() => !document.querySelector('.if-table').textContent.includes('Cannot read SQM'));
        checks.connection_recovered = true;
        assert.deepEqual(errors, []);
        console.log(JSON.stringify(checks, null, 2));
    } catch(e) {
        const pages = browser.contexts().flatMap(c => c.pages());
        if (pages[0]) {
            await pages[0].screenshot({path: path.join(out, 'failure.png'), fullPage: true}).catch(() => {});
            fs.writeFileSync(path.join(out, 'failure.txt'), await pages[0].locator('body').innerText().catch(() => 'Unavailable'));
        }
        throw e;
    } finally {
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({checks, pageErrors: errors}, null, 2));
        await browser.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
