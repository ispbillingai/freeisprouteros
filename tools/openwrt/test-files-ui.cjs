/* Local browser checks. No router, credentials or external requests are used. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const overlay = 'openwrt/files/www/luci-static/';
const source = fs.readFileSync(overlay + 'resources/view/freeisp/files.js', 'utf8');
const css = ['freeisp/cascade.css', 'resources/freeisp/files.css'].map(p => fs.readFileSync(overlay + p, 'utf8').replace(/@import[^;]+;/g, '')).join('\n');
const out = path.resolve('artifacts/tests/files');
fs.mkdirSync(out, {recursive: true});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 950}, acceptDownloads: true});
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/css', body: ''}));
        async function reset(options = {}) {
            await page.goto('about:blank');
            await page.setContent('<!doctype html><html><head><style>' + css + '\n*{box-sizing:border-box}body{margin:0}header{padding:20px}.modal{position:fixed;top:18%;left:50%;transform:translateX(-50%);width:min(640px,95vw);padding:25px;border:1px solid var(--fi-line);border-radius:8px;box-shadow:0 0 0 100vmax #0007;z-index:2000}#notifications{position:fixed;bottom:0;right:0;max-width:500px;background:var(--fi-panel)}</style></head><body class="freeisp-desktop"><header>Workspace / Files · Local preview with sample data</header><main id="maincontent"></main><div id="notifications"></div></body></html>');
            await page.evaluate(({source, options}) => {
                const root = '/srv/freeisp-files';
                const entry = (name, type = 'file', size = 4096) => ({name, type, size, mtime: 1791357600});
                const fixture = window.fixture = {calls: [], offline: !!options.offline, uploadFailure: false, removeFailure: false, changed: null,
                    folders: {[root]: [entry('hotspot', 'directory'), entry('config-2026-10-07.tar.gz', 'file', 114073), entry('notes.txt', 'file', 900), entry('system-link', 'symlink'), entry('../escape'), entry('<img onerror=alert(1)>.txt')], [root + '/hotspot']: [entry('login.html', 'file', 85196), entry('style.css')]}};
                function E(tag, attrs, children) {
                    const e = document.createElement(tag);
                    Object.entries(attrs || {}).forEach(([k, v]) => { if (typeof v === 'function') e.addEventListener(k, v); else if (v != null) e.setAttribute(k, v); });
                    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(c => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
                    return e;
                }
                const ui = {hideModal: () => document.querySelector('#fixture-modal')?.remove(), showModal: (title, contents) => {
                    ui.hideModal(); document.body.append(E('div', {id: 'fixture-modal', class: 'modal', role: 'dialog', 'aria-label': title}, [E('h3', {}, title), ...contents]));
                }, addNotification: (_, node) => document.querySelector('#notifications').append(node)};
                const filesystem = {
                    list: async p => { if (fixture.offline) throw Error('Connection lost'); fixture.calls.push(['list', p]); return structuredClone(fixture.folders[p] || []); },
                    lstat: async p => { if (fixture.offline) throw Error('Connection lost'); if (fixture.changed === p) return {type: 'symlink'};
                        if (fixture.folders[p]) return {type: 'directory'};
                        const i = p.lastIndexOf('/'); const item = (fixture.folders[p.slice(0, i)] || []).find(e => e.name === p.slice(i + 1));
                        if (!item) throw Error('Not found'); return structuredClone(item);
                    },
                    read_direct: async (p, type) => { fixture.calls.push(['download', p, type]); return new Blob([new Uint8Array([0, 255, 1, 128])]); },
                    remove: async p => { if (fixture.removeFailure) throw Error('Permission denied'); fixture.calls.push(['remove', p]); const i = p.lastIndexOf('/'); fixture.folders[p.slice(0, i)] = fixture.folders[p.slice(0, i)].filter(e => e.name !== p.slice(i + 1)); }
                };
                const request = {post: async (url, data) => {
                    fixture.calls.push(['upload', url, data.get('filename'), data.get('filedata').size]);
                    if (fixture.uploadFailure) return {ok: true, json: () => ({failure: 'ENOSPC', message: 'No space left'})};
                    const p = data.get('filename'), i = p.lastIndexOf('/'); fixture.folders[p.slice(0, i)].push(entry(p.slice(i + 1), 'file', data.get('filedata').size));
                    return {ok: true, json: () => ({size: data.get('filedata').size})};
                }};
                const L = {hasViewPermission: () => !options.readonly, resource: p => '/luci-static/resources/' + p, url: (...p) => '/cgi-bin/luci/' + p.join('/'), env: {sessionid: 'test-only', cgi_base: '/cgi-bin'}};
                const view = new Function('view', 'fs', 'ui', 'request', 'E', 'L', source)({extend: v => v}, filesystem, ui, request, E, L);
                document.querySelector('#maincontent').append(view.render());
            }, {source, options});
            await page.addScriptTag({content: fs.readFileSync(overlay + 'freeisp/navigation.js', 'utf8')});
            await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
            await page.waitForFunction(() => document.querySelector('#files-panel').getAttribute('aria-busy') === 'false');
        }
        const btn = name => page.getByRole('button', {name, exact: true});
        const select = name => page.getByRole('radio', {name: 'Select ' + name, exact: true}).check();
        const settled = () => page.waitForFunction(() => document.querySelector('#files-panel').getAttribute('aria-busy') === 'false');
        await reset();
        assert.equal(await page.locator('.if-table tbody tr').count(), 5);
        assert.equal(await page.locator('.if-table img').count(), 0, 'Filenames render as text');
        assert(await page.getByRole('radio', {name: 'Select system-link', exact: true}).isDisabled());
        assert.equal(await page.getByRole('link', {name: 'Backup…', exact: true}).getAttribute('href'), '/cgi-bin/luci/admin/system/flash');
        await page.screenshot({path: path.join(out, 'files-day.png'), fullPage: true});
        await btn('Use Night theme').click(); await page.screenshot({path: path.join(out, 'files-night.png'), fullPage: true});
        await page.setViewportSize({width: 390, height: 844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile page fits viewport');
        await page.screenshot({path: path.join(out, 'files-mobile.png'), fullPage: true});
        await page.setViewportSize({width: 1440, height: 950});
        await page.getByRole('searchbox').fill('missing'); assert.match(await page.locator('.if-table').innerText(), /No matching files/);
        await page.getByRole('searchbox').fill(''); await select('notes.txt');
        const downloadPromise = page.waitForEvent('download'); await btn('Download').click();
        const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'notes.txt');
        assert.deepEqual(fs.readFileSync(await download.path()), Buffer.from([0, 255, 1, 128]));
        await settled(); await btn('Delete').click(); await btn('Cancel').click();
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c[0] === 'remove').length), 0);
        await btn('Delete').click(); await btn('Delete file').click(); await settled();
        assert.equal(await page.getByRole('radio', {name: 'Select notes.txt', exact: true}).count(), 0);
        await btn('▸ hotspot').click(); await settled();
        assert.match(await page.locator('.if-table').innerText(), /login.html/);
        await btn('Upload…').click();
        await btn('Upload file').click(); assert.match(await page.getByRole('alert').innerText(), /Choose a file/);
        await page.getByLabel('Choose file', {exact: true}).setInputFiles({name: 'bad\u0001.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('bad')});
        await btn('Upload file').click(); assert.match(await page.getByRole('alert').innerText(), /valid filename/);
        await page.getByLabel('Choose file', {exact: true}).setInputFiles({name: 'new.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 1])});
        await btn('Upload file').click(); await settled();
        assert.deepEqual((await page.evaluate(() => fixture.calls)).find(c => c[0] === 'upload'), ['upload', '/cgi-bin/cgi-upload', '/srv/freeisp-files/hotspot/new.bin', 3]);
        await btn('Upload…').click(); await page.getByLabel('Choose file', {exact: true}).setInputFiles({name: 'new.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('replacement')});
        await btn('Upload file').click(); await settled();
        assert.match(await page.getByRole('alert').innerText(), /already exists/);
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c[0] === 'upload').length), 1);
        await btn('Cancel').click(); await btn('Files').click(); await settled();
        await page.getByRole('tab', {name: 'Cloud Backup', exact: true}).click(); assert.match(await page.getByRole('tabpanel').innerText(), /not configured/);
        await page.getByRole('tab', {name: 'Cloud Backup', exact: true}).press('ArrowLeft');
        assert.equal(await page.getByRole('tab', {name: 'File', exact: true}).getAttribute('aria-selected'), 'true');
        await select('config-2026-10-07.tar.gz'); await page.evaluate(() => { fixture.changed = '/srv/freeisp-files/config-2026-10-07.tar.gz'; });
        await btn('Delete').click(); await btn('Delete file').click(); await settled();
        assert.match(await page.getByRole('alert').innerText(), /file changed/);
        assert.equal(await page.evaluate(() => fixture.calls.filter(c => c[0] === 'remove').length), 1);
        await reset({readonly: true}); assert(await btn('Upload…').isDisabled());
        await select('notes.txt'); assert(await btn('Delete').isDisabled()); assert(!(await btn('Download').isDisabled()));
        await reset({offline: true}); assert.match(await page.locator('.if-table').innerText(), /Unable to load files/); assert(await btn('Upload…').isDisabled());
        await page.evaluate(() => { fixture.offline = false; }); await btn('Refresh').click(); await settled();
        assert.match(await page.locator('.if-table').innerText(), /notes.txt/);
        await page.evaluate(() => { fixture.uploadFailure = true; }); await btn('Upload…').click();
        await page.getByLabel('Choose file', {exact: true}).setInputFiles({name: 'full.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('test')});
        await btn('Upload file').click(); await settled(); assert.match(await page.getByRole('alert').innerText(), /No space left/);
        await btn('Cancel').click(); await select('notes.txt'); await page.evaluate(() => { fixture.removeFailure = true; });
        await btn('Delete').click(); await btn('Delete file').click(); await settled(); assert.match(await page.getByRole('alert').innerText(), /Permission denied/);
        assert.equal(await page.getByRole('radio', {name: 'Select notes.txt', exact: true}).count(), 1);
        assert.deepEqual(errors, []);
        console.log('Files browser checks passed: navigation, filtering, binary download, upload, duplicates, confirmed delete, stale symlink, read-only, offline recovery, upload/delete failures, safe filenames, tabs, Day/Night and mobile.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
