/* Browser checks use local sample RPC only; no live router is modified. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const overlay = 'openwrt/files/www/luci-static/';
const sources = {
    engine: fs.readFileSync(overlay + 'resources/freeisp/command-line.js', 'utf8'),
    backend: fs.readFileSync(overlay + 'resources/freeisp/command-line-backend.js', 'utf8'),
    view: fs.readFileSync(overlay + 'resources/view/freeisp/command-line.js', 'utf8')
};
const css = fs.readFileSync(overlay + 'freeisp/cascade.css', 'utf8').replace(/@import[^;]+;/, '') + fs.readFileSync(overlay + 'resources/freeisp/command-line.css', 'utf8');
const out = path.resolve('artifacts/tests/command-line');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 980}}), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => d.accept());
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>' + css + '\n*{box-sizing:border-box}body{margin:0}header{padding:20px}.sample-note{font:12px sans-serif;color:var(--fi-muted);margin-left:20px}</style></head><body class="freeisp-desktop"><header><span>Workspace / Command Line</span><span class="sample-note">Local test preview · sample router data</span></header><main id="maincontent"></main></body></html>');
            await page.evaluate(({sources, options}) => {
                window.fixture = {writes: [], calls: [], offline: false, delay: false, name: 'FreeISP', pending: {}};
                const f = window.fixture;
                window.L = {env: {username: 'root'}, resource: p => '/luci-static/resources/' + p, hasViewPermission: () => !options.readonly};
                function E(tag, attrs, children) {
                    const e = document.createElement(tag);
                    Object.entries(attrs || {}).forEach(([k, v]) => typeof v === 'function' ? e.addEventListener(k, v) : e.setAttribute(k, v));
                    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(c => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
                    return e;
                }
                const rpc = {declare: spec => async () => {
                    f.calls.push(spec.method);
                    if (f.offline) throw Error('Session expired or router unavailable');
                    if (spec.method === 'board') return {hostname: f.name, model: 'FreeISP x86/64', system: 'x86_64', release: {version: '25.12.5'}};
                    if (spec.method === 'info') return {uptime: 8200, memory: {total: 536870912, free: 389545984}, load: [1024, 2048, 512]};
                    if (spec.method === 'getNetworkDevices') return {
                        eth0: {type: 1, up: true, mtu: 1500, mac: '52:54:00:F1:00:01'},
                        eth1: {type: 1, up: true, mtu: 1500, mac: '52:54:00:F1:00:02'},
                        'br-lan': {type: 1, devtype: 'bridge', up: true, mtu: 1500, mac: '52:54:00:F1:00:02'}};
                    if (spec.method === 'dump') return [{interface: 'lan', device: 'br-lan', 'ipv4-address': [{address: '10.77.0.1', mask: 24}], 'dns-server': ['1.1.1.1']}];
                    throw Error('Unexpected RPC');
                }};
                const uci = {unload() {}, async load() {}, sections: name => name === 'system' ? [{'.name': 'sys', hostname: f.name}] : [], changes: async () => f.pending,
                    set(...args) { f.writes.push(['set', ...args]); }, save: async () => f.writes.push(['save'])};
                const ui = {changes: {init: async () => {}, apply: async flag => f.writes.push(['apply', flag])}};
                const filesystem = {exec: async (cmd, args) => {
                    f.calls.push([cmd, args]);
                    if (f.delay) await new Promise(resolve => { f.release = resolve; });
                    return {code: 0, stdout: f.output || 'PING 1.1.1.1: 56 data bytes\n4 packets transmitted, 4 received, 0% packet loss'};
                }};
                const base = {extend: v => v};
                const engine = new Function('baseclass', sources.engine)(base);
                const backend = new Function('baseclass', 'rpc', 'fs', 'uci', 'ui', 'L', sources.backend)(base, rpc, filesystem, uci, ui, window.L);
                const view = new Function('view', 'commandLine', 'backendModule', 'E', 'L', sources.view)(base, engine, backend, E, window.L);
                document.querySelector('main').append(view.render());
            }, {sources, options});
            await page.addScriptTag({content: fs.readFileSync(overlay + 'freeisp/navigation.js', 'utf8')});
            await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
            await page.waitForFunction(() => document.querySelector('.cl-state').textContent === 'Ready');
        }
        const input = () => page.getByRole('textbox', {name: 'Command', exact: true});
        const output = () => page.getByRole('log');
        async function command(line) {
            await input().fill(line); await input().press('Enter');
            await page.waitForFunction(() => !document.querySelector('.cl-input').disabled);
        }
        await reset();
        assert.equal(await page.getByRole('heading', {name: 'Command Line'}).count(), 1);
        assert.equal(await page.getByRole('link', {name: 'Command Line', exact: true}).getAttribute('href'), '/cgi-bin/luci/admin/system/freeisp_command_line');
        await input().fill('/sys'); await input().press('Tab'); assert.equal(await input().inputValue(), '/system ');
        await command('/system resource print'); assert.match(await output().innerText(), /memory-total-bytes: 536870912/);
        await command('/interface print'); assert.match(await output().innerText(), /52:54:00:F1:00:01/);
        await command('/ip address'); assert.match(await page.locator('.cl-prompt').innerText(), /\/ip\/address>/);
        await command('print'); assert.match(await output().innerText(), /10.77.0.1\/24/);
        await command('..'); assert.match(await page.locator('.cl-prompt').innerText(), /\/ip>/);
        await command('/'); assert.equal(await page.locator('.cl-prompt').innerText(), '[root@FreeISP] >');
        await input().fill('unfinished'); await input().press('ArrowUp'); assert.equal(await input().inputValue(), '/');
        await input().press('ArrowDown'); assert.equal(await input().inputValue(), 'unfinished');
        await input().press('Control+c'); assert.equal(await input().inputValue(), '');
        await command('ping 1.1.1.1 count=4'); assert.match(await output().innerText(), /0% packet loss/);
        await page.screenshot({path: path.join(out, 'command-line-day.png'), fullPage: true});
        await page.getByRole('button', {name: 'Use Night theme'}).click();
        await page.screenshot({path: path.join(out, 'command-line-night.png'), fullPage: true});
        await page.setViewportSize({width: 390, height: 844});
        await page.screenshot({path: path.join(out, 'command-line-mobile.png'), fullPage: true});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Must fit mobile width');
        assert(await page.getByRole('heading', {name: 'Command Line'}).evaluate(el => el.getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom), 'Mobile heading must not hide behind the header');
        await page.setViewportSize({width: 1440, height: 980});
        await command('/unsupported command'); assert.match(await output().innerText(), /Unknown command/);
        await page.evaluate(() => { fixture.output = '<img src=x onerror="window.injected=true">'; });
        await command('/log print'); assert.match(await output().innerText(), /<img src=x/);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        assert.equal(await output().locator('img').count(), 0);
        await input().evaluate(el => { const data = new DataTransfer(); data.setData('text', '/interface print\n/system resource print'); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true})); });
        assert.match(await output().innerText(), /Paste one command/);
        await page.evaluate(() => { fixture.delay = true; });
        await input().fill('ping 1.1.1.1'); await input().press('Enter');
        assert(await input().isDisabled()); assert(await page.getByRole('button', {name: 'Run', exact: true}).isDisabled());
        await page.waitForFunction(() => fixture.release); await page.evaluate(() => { fixture.release(); fixture.delay = false; });
        await page.waitForFunction(() => !document.querySelector('.cl-input').disabled);
        await command('/system identity set name=Branch-1'); assert.equal(await page.evaluate(() => fixture.writes.length), 0);
        await command('/pending'); assert.match(await output().innerText(), /FreeISP -> Branch-1/);
        await command('/apply'); assert.deepEqual(await page.evaluate(() => fixture.writes), [['set', 'system', 'sys', 'hostname', 'Branch-1'], ['save'], ['apply', true]]);
        await reset({readonly: true}); await command('/system identity set name=Denied');
        assert.match(await output().innerText(), /read-only/); assert.equal(await page.evaluate(() => fixture.writes.length), 0);
        await page.evaluate(() => { fixture.offline = true; }); await command('/system resource print');
        assert.match(await output().innerText(), /Session expired or router unavailable/);
        await page.getByRole('button', {name: 'Clear', exact: true}).click(); assert.equal(await output().innerText(), '');
        await page.getByRole('button', {name: 'Help', exact: true}).click(); assert.match(await output().innerText(), /Menu: \//);
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({passed: true, router: 'local mocked RPC only', pageErrors: errors}, null, 2));
        console.log('Command Line browser checks passed: navigation, Enter, completion, history, prompt, diagnostics, safe output, paste guard, busy state, staged apply, readonly, offline, Day/Night and mobile.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
