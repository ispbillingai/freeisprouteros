/* Browser interaction regression tests. Backend fixture; real packets use the VM test. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const source = fs.readFileSync('openwrt/files/www/luci-static/resources/view/freeisp/pppoe.js', 'utf8');
const css = fs.readFileSync('openwrt/files/www/luci-static/resources/freeisp/pppoe.css', 'utf8');
const out = path.resolve('artifacts/tests/pppoe');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1400, height: 900}});
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => route.fulfill({contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>body{font:14px Segoe UI;padding:24px}*{box-sizing:border-box}.modal{position:fixed;inset:5% 20%;padding:25px;background:white;box-shadow:0 0 0 100vmax #0007;overflow:auto}.pp-card{max-width:100%}' + css + '</style></head><body><main></main><aside id="notifications"></aside></body></html>');
            await page.evaluate(async ({source, options}) => {
                const state = window.fixture = {config: {pools: [], profiles: [], servers: [], secrets: []}, revision: 'initial', calls: [], fail: false, saveFail: false, knownError: '', readonly: !!options.readonly};
                const live = () => ({available: true, servers: state.config.servers.map(r => ({id: r.id, state: r.enabled ? 'Running' : 'Disabled', running: r.enabled})), sessions: [], revision: state.revision});
                function E(tag, attrs, children) {
                    const node = document.createElement(tag);
                    for (const [key, value] of Object.entries(attrs || {})) {
                        if (typeof value === 'function') node.addEventListener(key, value);
                        else if (value != null) node.setAttribute(key, String(value));
                    }
                    for (const child of (Array.isArray(children) ? children : children == null ? [] : [children])) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
                    return node;
                }
                const rpc = {declare: spec => async (...args) => {
                    state.calls.push([spec.method, args]);
                    if (state.fail || spec.method === 'save' && state.saveFail || options.loadFail) throw new Error('Router unreachable');
                    if (spec.method === 'get') return {config: structuredClone(state.config), revision: state.revision, status: live(), interfaces: [{name: 'br-lan', up: true}]};
                    if (spec.method === 'status') return live();
                    if (spec.method === 'save') {
                        if (state.knownError) return {error: state.knownError};
                        state.config = structuredClone(args[0]); state.revision = 'saved';
                        for (const r of state.config.secrets) { delete r.password; r.has_password = true; r.assigned_ip = '10.80.0.10'; }
                        return {config: structuredClone(state.config), revision: state.revision, status: live()};
                    }
                    return {disconnecting: true};
                }};
                const ui = {showModal: (title, children) => { ui.hideModal(); const modal = E('div', {class: 'modal', role: 'dialog'}, [E('h3', {}, title), ...children]); document.body.append(modal); }, hideModal: () => document.querySelector('.modal')?.remove(), addNotification: (_, node) => document.querySelector('#notifications').append(node)};
                const view = new Function('view', 'rpc', 'ui', 'poll', 'E', 'L', source)({extend: v => v}, rpc, ui, {add: cb => window.refresh = cb}, E, {resource: p => p, hasViewPermission: () => !state.readonly});
                document.querySelector('main').append(view.render(await view.load()));
            }, {source, options});
        }
        const btn = name => page.getByRole('button', {name, exact: true});
        const tab = name => page.getByRole('tab', {name, exact: true}).click();
        async function addPool() {
            await tab('Address Pools'); await btn('+ Add pool').click();
            await page.getByLabel('Name', {exact: true}).fill('customers');
            await page.getByLabel('First address').fill('10.80.0.10'); await page.getByLabel('Last address').fill('10.80.0.50');
            await btn('Save to review').click();
        }
        async function apply() { await btn('Save & apply').click(); await page.getByRole('dialog').getByRole('button', {name: 'Save & apply', exact: true}).click(); }
        await reset();
        assert.equal(await page.getByRole('tab').count(), 5);
        await addPool();
        await tab('Profiles'); await btn('+ Add profile').click();
        await page.getByLabel('Name', {exact: true}).fill('basic'); await page.getByLabel('Local address').fill('10.80.0.1');
        await page.getByLabel('Remote address pool').selectOption({label: 'customers'});
        await page.getByLabel('Download · kbit/s').fill('2048'); await btn('Save to review').click();
        await tab('PPPoE Servers'); await btn('+ Add server').click();
        await page.getByLabel('Service name').fill('internet'); await page.getByLabel('Interface', {exact: true}).selectOption('br-lan');
        await page.getByLabel('Default profile').selectOption({label: 'basic'}); await btn('Save to review').click();
        await tab('Secrets'); await btn('+ Add secret').click(); await page.getByLabel('Username').fill('customer');
        await page.getByLabel('Password', {exact: true}).fill('sample-only'); await page.getByLabel('PPPoE server', {exact: true}).selectOption({label: 'internet'}); await btn('Save to review').click();
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c[0] === 'save').length), 0);
        await apply(); assert.match(await page.locator('.pp-footer').innerText(), /Settings saved/);
        assert.equal(await page.evaluate(() => fixture.config.profiles[0].download), 2048);
        assert.match(await page.locator('.pp-table').innerText(), /10.80.0.10/);
        await btn('Edit').click(); assert.equal(await page.getByLabel('Password', {exact: true}).inputValue(), ''); await btn('Cancel').click();
        await tab('Address Pools'); await btn('Remove').click(); assert.match(await page.locator('#notifications').innerText(), /still in use/);
        await page.getByRole('searchbox').fill('does-not-exist'); assert.match(await page.locator('.pp-table').innerText(), /No matching/);
        await page.getByRole('searchbox').fill('');
        await page.screenshot({path: path.join(out, 'pools-day.png'), fullPage: true});
        await page.evaluate(async () => { fixture.fail = true; await refresh(); });
        assert.match(await page.locator('.pp-heading').innerText(), /Connection lost/);
        await tab('Active Connections'); assert.match(await page.locator('.pp-table').innerText(), /unknown/);
        await reset(); await addPool(); await page.evaluate(() => fixture.knownError = 'Pool overlaps an existing router network.'); await apply();
        assert.match(await page.locator('#notifications').innerText(), /overlaps/); assert.match(await page.locator('.pp-footer').innerText(), /Unsaved/);
        await page.evaluate(() => { fixture.knownError = ''; fixture.saveFail = true; }); await apply();
        assert.match(await page.locator('.pp-footer').innerText(), /Save result unknown/); assert(await btn('Save & apply').isDisabled()); assert(await btn('+ Add pool').isDisabled());
        await reset({readonly: true}); assert(await btn('+ Add server').isDisabled());
        await reset({loadFail: true}); assert.match(await page.getByRole('alert').innerText(), /unreachable/); assert(await btn('Retry').isVisible());
        await reset(); await tab('Profiles'); await btn('+ Add profile').click(); await page.getByLabel('Name', {exact: true}).fill('*bad'); await page.getByLabel('Local address').fill('10.80.0.1');
        await btn('Save to review').click(); assert(await page.getByRole('dialog').isVisible()); await btn('Cancel').click();
        await page.setViewportSize({width: 390, height: 844}); await tab('Address Pools');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path: path.join(out, 'pools-mobile.png'), fullPage: true});
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({passed: true, checks: ['create pool/profile/server/secret', 'apply payload', 'password blank on edit', 'reference protection', 'search', 'status failure', 'validation error', 'uncertain save protection', 'readonly', 'load failure', 'mobile width', 'no browser errors']}, null, 2));
        console.log('PPPoE browser checks passed.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
