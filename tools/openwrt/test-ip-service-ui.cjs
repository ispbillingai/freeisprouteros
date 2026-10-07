// Local fixture: exercises the shipped LuCI view with mock RPC and no router access.
// Install Playwright, or set NODE_PATH to an existing installation. Optionally set
// FREEISP_BROWSER_CHANNEL=msedge (or chrome) to use an installed browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const artifacts = path.join(root, 'artifacts', 'ip-service');
const sources = {
    data: read('openwrt/files/www/luci-static/resources/freeisp/ip-service-data.js'),
    view: read('openwrt/files/www/luci-static/resources/view/freeisp/ip-service.js')
};
const assets = {
    '/theme.css': read('openwrt/files/www/luci-static/freeisp/cascade.css').replace(/^@import[^;]+;/, ''),
    '/luci-static/resources/freeisp/ip-service.css': read('openwrt/files/www/luci-static/resources/freeisp/ip-service.css')
};
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IP Service local fixture</title><link rel="stylesheet" href="/theme.css"><style>
*{box-sizing:border-box}body{margin:0;padding:30px}main{max-width:1360px;margin:auto}button,input{font:inherit}h2{line-height:1.2}.fixture-overlay{position:fixed;inset:0;background:#0007;display:grid;place-items:center;padding:20px}.modal{width:min(760px,100%);padding:24px;border-radius:8px;max-height:90vh;overflow:auto;border:1px solid var(--fi-line)}.modal h3{margin-top:0}.modal p{line-height:1.6}@media(max-width:800px){body{padding:16px}.fixture-overlay{padding:12px}.modal{padding:16px}}
</style></head><body><main><p style="font-size:12px;color:var(--fi-muted)">Local preview · sample router data</p><div id="fixture"></div></main></body></html>`;

async function mount(page) {
    await page.evaluate(async ({sources}) => {
        function E(tag, attrs, children) {
            const element = document.createElement(tag);
            for (const [key, value] of Object.entries(attrs || {})) {
                if (typeof value === 'function') element.addEventListener(key, value);
                else element.setAttribute(key, value);
            }
            function append(child) {
                if (Array.isArray(child)) child.forEach(append);
                else if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
            }
            append(children);
            return element;
        }
        window.fixture = {
            calls: [], failed: [], delay: 0,
            services: Object.fromEntries(['freeisp-api', 'freeisp-ftp', 'dropbear', 'uhttpd'].map(name => [name, {[name]: {instances: {main: {running: true}}}}])),
            values: {
                freeisp_api: {main: {'.type': 'service', enabled: '1', port: '8728', listen_address: '0.0.0.0'}},
                freeisp_ftp: {main: {'.type': 'service', enabled: '1', port: '21', listen_address: '0.0.0.0'}},
                dropbear: {
                    lan: {'.type': 'dropbear', '.name': 'lan', Port: '22', Interface: 'lan'}
                },
                uhttpd: {main: {'.type': 'uhttpd', '.name': 'main', listen_http: ['0.0.0.0:80', '[::]:80'], listen_https: ['0.0.0.0:443', '[::]:443']}}
            }
        };
        const rpc = {declare: options => async name => {
            window.fixture.calls.push({object: options.object, method: options.method, name});
            await new Promise(resolve => setTimeout(resolve, window.fixture.delay));
            if (window.fixture.failed.includes(name)) throw new Error('Mock configuration read failed');
            return structuredClone(options.object === 'uci' ? window.fixture.values[name] : window.fixture.services[name]);
        }};
        const ui = {
            hideModal: () => document.querySelector('.fixture-overlay')?.remove(),
            showModal: (title, children) => {
                ui.hideModal();
                document.body.append(E('div', {class: 'fixture-overlay'}, E('section', {class: 'modal', role: 'dialog', 'aria-label': title}, [E('h3', {}, title), children])));
            }
        };
        const L = {url: (...parts) => '/cgi-bin/luci/' + parts.join('/'), resource: value => '/luci-static/resources/' + value};
        const data = new Function('baseclass', sources.data)({extend: value => value});
        const view = new Function('view', 'rpc', 'ui', 'data', 'E', 'L', sources.view)({extend: value => value}, rpc, ui, data, E, L);
        document.querySelector('#fixture').replaceChildren(view.render(await view.load()));
    }, {sources});
    await page.getByRole('table', {name: 'IP Service list', exact: true}).waitFor();
}

async function main() {
    fs.mkdirSync(artifacts, {recursive: true});
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/') {
            response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(html);
        } else if (assets[pathname]) {
            response.writeHead(200, {'Content-Type': 'text/css; charset=utf-8'}).end(assets[pathname]);
        } else response.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
        const page = await browser.newPage({viewport: {width: 1440, height: 920}, deviceScaleFactor: 1});
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        const origin = `http://127.0.0.1:${server.address().port}`;
        await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
        await page.goto(origin);
        await mount(page);
        const table = page.getByRole('table', {name: 'IP Service list', exact: true});
        const serviceNames = () => table.locator('tbody .ips-name').allTextContents();
        assert.deepEqual(await serviceNames(), ['API', 'FTP', 'SSH', 'FreeISP Desk', 'WWW']);
        assert.deepEqual(await table.locator('tbody .ips-state').allTextContents(), ['Running', 'Running', 'Running', 'Running', 'Running']);
        assert.deepEqual(await table.locator('tbody .ips-port').allTextContents(), ['8728', '21', '22', '80, 443', '80, 443']);
        await page.screenshot({path: path.join(artifacts, 'ip-service-day.png'), fullPage: true});

        await page.getByRole('button', {name: 'SSH details', exact: true}).click();
        let dialog = page.getByRole('dialog', {name: 'SSH', exact: true});
        assert.equal(await dialog.getByRole('table').locator('tbody tr').count(), 1);
        assert.match(await dialog.innerText(), /22/);
        assert.equal(await dialog.getByRole('link', {name: 'SSH settings'}).getAttribute('href'), '/cgi-bin/luci/admin/system/admin/dropbear');
        await page.screenshot({path: path.join(artifacts, 'ip-service-ssh-details.png'), fullPage: true});
        await dialog.getByRole('button', {name: 'Close', exact: true}).click();

        await page.getByRole('button', {name: 'FreeISP Desk details', exact: true}).click();
        dialog = page.getByRole('dialog', {name: 'FreeISP Desk', exact: true});
        assert.equal(await dialog.getByRole('table').locator('tbody tr').count(), 4);
        assert.match(await dialog.innerText(), /does not have a separate service port/);
        assert.equal(await dialog.getByRole('link', {name: 'Web settings'}).getAttribute('href'), '/cgi-bin/luci/admin/system/admin/uhttpd');
        await dialog.getByRole('button', {name: 'Close', exact: true}).click();

        await page.getByRole('button', {name: 'API details', exact: true}).click();
        dialog = page.getByRole('dialog', {name: 'API', exact: true});
        assert.match(await dialog.innerText(), /root account/);
        assert.equal(await dialog.getByRole('link', {name: 'API settings'}).getAttribute('href'), '/cgi-bin/luci/admin/network/freeisp_api_settings');
        assert.equal(await dialog.getByRole('table').count(), 1);
        await dialog.getByRole('button', {name: 'Close', exact: true}).click();
        await page.getByRole('button', {name: 'FTP details', exact: true}).click();
        dialog = page.getByRole('dialog', {name: 'FTP', exact: true});
        assert.match(await dialog.innerText(), /confined/);
        assert.equal(await dialog.getByRole('link', {name: 'FTP settings'}).getAttribute('href'), '/cgi-bin/luci/admin/network/freeisp_ftp_settings');
        await dialog.getByRole('button', {name: 'Close', exact: true}).click();

        const search = page.getByRole('searchbox', {name: 'Find a service'});
        for (const [query, names] of [
            [' ssh ', ['SSH']], ['443', ['FreeISP Desk', 'WWW']], ['[::]', ['FreeISP Desk', 'WWW']],
            ['8728', ['API']], ['Upload', ['FTP']], ['Secure command-line', ['SSH']], ['no-such-service', []]
        ]) {
            await search.fill(query);
            assert.deepEqual(await serviceNames(), names, query);
            assert.equal(await page.locator('.ips-footer > span').textContent(), `${names.length} of 5 services`);
        }
        assert.match(await table.innerText(), /No matching services/);
        await search.fill('');

        await page.evaluate(() => document.documentElement.dataset.freeispTheme = 'night');
        assert.equal(await page.locator('.ips-card').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(20, 43, 58)');
        await page.screenshot({path: path.join(artifacts, 'ip-service-night.png'), fullPage: true});
        await page.setViewportSize({width: 390, height: 844});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not overflow horizontally');
        assert.ok(await table.evaluate(element => element.parentElement.scrollWidth > element.parentElement.clientWidth), 'wide table remains available through its own horizontal scroll');
        await page.screenshot({path: path.join(artifacts, 'ip-service-mobile.png'), fullPage: true});
        await page.setViewportSize({width: 1440, height: 920});
        await page.evaluate(() => document.documentElement.dataset.freeispTheme = 'day');

        await page.evaluate(() => { window.fixture.failed = ['dropbear', 'uhttpd']; window.fixture.delay = 250; });
        const refresh = page.getByRole('button', {name: 'Refresh', exact: true});
        await refresh.click();
        assert.equal(await refresh.isDisabled(), true);
        await page.waitForFunction(() => !document.querySelector('.ips-toolbar button').disabled);
        assert.deepEqual(await table.locator('tbody .ips-state').allTextContents(), ['Running', 'Running', 'Unknown', 'Unknown', 'Unknown']);
        assert.deepEqual(await table.locator('tbody .ips-port').allTextContents(), ['8728', '21', '—', '—', '—']);
        assert.match(await page.getByRole('status').innerText(), /could not be read/);
        await page.screenshot({path: path.join(artifacts, 'ip-service-read-failure.png'), fullPage: true});
        await page.getByRole('button', {name: 'SSH details', exact: true}).click();
        dialog = page.getByRole('dialog', {name: 'SSH', exact: true});
        assert.match(await dialog.innerText(), /could not be read/);
        assert.equal(await dialog.getByRole('table').count(), 0);
        await dialog.getByRole('button', {name: 'Close', exact: true}).click();

        await page.evaluate(() => {
            window.fixture.failed = [];
            window.fixture.values.dropbear = {main: {'.type': 'dropbear', Port: '2223', enable: '0'}};
            window.fixture.services.dropbear = {};
        });
        await refresh.click();
        await page.waitForFunction(() => !document.querySelector('.ips-toolbar button').disabled);
        const sshRow = table.locator('tbody tr').filter({has: page.locator('.ips-name', {hasText: /^SSH$/})});
        assert.equal(await sshRow.locator('.ips-state').textContent(), 'Disabled');
        assert.equal(await sshRow.locator('.ips-port').textContent(), '2223');
        assert.equal(await page.getByRole('status').innerText(), 'Router services loaded');
        const calls = await page.evaluate(() => window.fixture.calls);
        assert.equal(calls.length, 24, 'initial load and two refreshes each perform eight reads');
        assert.ok(calls.every(call => call.object === 'uci' && call.method === 'get' || call.object === 'service' && call.method === 'list'));
        assert.deepEqual(pageErrors, []);
        console.log('IP Service UI passed: five rows, details, search, read failures/recovery, day/night, and mobile table scrolling.');
        console.log(`Local fixture screenshots: ${artifacts}`);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
