/* Run only against the disposable guests started by test-interfaces-vm.py. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const out = 'artifacts/tests/interfaces-vm/';
const connection = JSON.parse(fs.readFileSync(out + 'local-session.json', 'utf8'));
const address = new URL(connection.url);
assert.equal(address.hostname, '127.0.0.1', 'Live suite accepts only the local disposable guest');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.FREEISP_BROWSER_CHANNEL ? {channel: process.env.FREEISP_BROWSER_CHANNEL} : {})});
    const result = {passed: false, checks: [], rpcFailures: []};
    let page;
    let phase = 'login';
    try {
        page = await browser.newPage({viewport: {width: 1440, height: 950}});
        const errors = [];
        page.on('pageerror', e => {
            // This LuCI release probes its configuration on the login screen.
            // Anonymous UCI access is correctly denied before authentication.
            if (phase === 'login' && e.message.startsWith('RPC call to uci/get failed with error -32002: Access denied')) {
                result.expectedAnonymousDenials = (result.expectedAnonymousDenials || 0) + 1;
                return;
            }
            errors.push({phase, message: e.message});
        });
        page.on('response', async response => {
            if (!new URL(response.url()).pathname.includes('/ubus')) return;
            try {
                const requests = [].concat(response.request().postDataJSON() || []);
                const replies = [].concat(await response.json());
                replies.filter(r => r.error || Array.isArray(r.result) && typeof r.result[0] === 'number' && r.result[0] !== 0).forEach(r => {
                    const request = requests.find(q => q.id === r.id), p = request?.params || [];
                    const failure = {phase, object: p[1], method: p[2], config: p[3]?.config, code: r.error?.code || r.result?.[0], page: new URL(page.url()).pathname};
                    result.rpcFailures.push(failure);
                    console.log('RPC diagnostic:', JSON.stringify(failure));
                });
            } catch (_) {}
        });
        page.on('dialog', d => d.accept());
        let sid = '0'.repeat(32);
        async function rpc(object, method, args = {}) {
            const response = await page.request.post(connection.url + '/ubus', {data: {jsonrpc: '2.0', id: 1, method: 'call', params: [sid, object, method, args]}});
            const payload = await response.json();
            assert.equal(payload.result[0], 0, object + '.' + method);
            return payload.result[1] || {};
        }
        sid = (await rpc('session', 'login', {username: connection.username, password: connection.password})).ubus_rpc_session;
        const config = async () => (await rpc('uci', 'get', {config: 'network'})).values;
        async function waitMTU(name, expected) {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                if ((await rpc('network.device', 'status', {name})).mtu === expected) return;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            assert.equal((await rpc('network.device', 'status', {name})).mtu, expected);
        }
        const tab = name => page.getByRole('tab', {name, exact: true}).click();
        const btn = name => page.getByRole('button', {name, exact: true});
        await page.goto(connection.url + '/cgi-bin/luci/admin/network/freeisp_interfaces');
        await page.locator('input[name=luci_username]').fill(connection.username);
        await page.locator('input[name=luci_password]').fill(connection.password);
        await page.getByRole('button', {name: /log ?in/i}).click();
        await page.getByRole('tab', {name: 'VLAN', exact: true}).waitFor({timeout: 30000});
        phase = 'authenticated';
        assert.equal(await page.getByRole('tab').count(), 4);
        result.checks.push('Authenticated real LuCI view loads all four tabs');
        await tab('Ethernet'); assert(await page.locator('.if-table').innerText().then(t => t.includes('eth1')));
        await tab('Interface List'); assert.match(await page.locator('.if-table').innerText(), /10.78.0.15/);
        await tab('VLAN'); await btn('+ Add VLAN').click();
        await page.getByLabel('Name', {exact: true}).fill('ui-vlan');
        await page.getByLabel('Parent interface').selectOption('eth1');
        await page.getByLabel('VLAN ID', {exact: true}).fill('4095');
        await btn('Save to review').click(); assert.match(await page.getByRole('alert').innerText(), /4094/);
        result.checks.push('Invalid VLAN ID rejected by real loaded view');
        await page.getByLabel('VLAN ID', {exact: true}).fill('333'); await btn('Save to review').click();
        assert(!Object.values(await config()).some(s => s.name === 'ui-vlan'), 'Draft must not alter persisted UCI');
        async function apply() {
            await btn('Review & apply').click();
            const navigation = page.waitForEvent('domcontentloaded', {timeout: 45000});
            await btn('Apply changes').click();
            // Checked apply can request a second connectivity confirmation.
            const checked = page.getByRole('button', {name: 'Apply checked', exact: true});
            await checked.waitFor({timeout: 1500}).then(() => checked.click()).catch(() => {});
            await navigation;
            await page.getByRole('tab', {name: 'VLAN', exact: true}).waitFor({timeout: 30000});
            await tab('VLAN');
        }
        await apply();
        let saved = Object.values(await config()).find(s => s.name === 'ui-vlan');
        assert(saved && saved.vid === '333' && saved.ifname === 'eth1' && saved.type === '8021q');
        result.checks.push('UI add persists real UCI device through checked apply and page reload');
        await page.locator('.if-table tbody tr').filter({hasText: 'ui-vlan'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('VLAN ID', {exact: true}).fill('334'); await btn('Save to review').click(); await apply();
        saved = Object.values(await config()).find(s => s.name === 'ui-vlan');
        assert.equal(saved.vid, '334'); result.checks.push('UI edit persists real VLAN ID');
        await page.screenshot({path: out + 'live-vlan.png', fullPage: true});
        await page.locator('.if-table tbody tr').filter({hasText: 'ui-vlan'}).getByRole('button', {name: 'Remove', exact: true}).click();
        await btn('Remove VLAN').click(); await apply();
        assert(!Object.values(await config()).some(s => s.name === 'ui-vlan'));
        result.checks.push('UI delete removes only its real device');
        await tab('Ethernet');
        await page.locator('.if-table tbody tr').filter({hasText: 'eth1'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('MTU', {exact: true}).fill('1400'); await btn('Save to review').click(); await apply();
        await waitMTU('eth1', 1400);
        result.checks.push('Ethernet editor changes actual running port MTU');
        await tab('Ethernet');
        await page.locator('.if-table tbody tr').filter({hasText: 'eth1'}).getByRole('button', {name: 'Edit', exact: true}).click();
        await page.getByLabel('MTU', {exact: true}).fill(''); await btn('Save to review').click(); await apply();
        await waitMTU('eth1', 1500);
        result.checks.push('Empty Ethernet MTU restores hardware default');
        phase = 'connection failure';
        const ubusURL = url => url.pathname.includes('/ubus');
        await page.route(ubusURL, route => route.abort());
        await page.getByText('Connection lost · showing last received values', {exact: true}).waitFor({timeout: 20000});
        await page.unroute(ubusURL);
        await page.locator('.if-heading').getByText(/Live · updated/).waitFor({timeout: 20000});
        result.checks.push('Live connection failure displayed and polling recovers');
        phase = 'quickset';
        await page.goto(connection.url + '/cgi-bin/luci/admin/freeisp');
        await page.locator('.qs-window').waitFor();
        assert.equal(await page.locator('#qs-lanIP').inputValue(), '10.77.0.1');
        await btn('Apply changes').click();
        await page.getByText('No changes to apply', {exact: true}).waitFor();
        result.checks.push('Existing Quick Set loads real settings and unchanged Apply writes nothing');
        assert.deepEqual(errors, []);
        result.passed = true;
        console.log('Live LuCI browser checks passed: authentication, real status, validation, add/edit/delete persistence, checked apply, connection loss and recovery.');
    } catch(e) {
        result.error = e.message;
        if (page) {
            await page.screenshot({path: out + 'live-error.png', fullPage: true}).catch(() => {});
            fs.writeFileSync(out + 'live-error.txt', await page.locator('body').innerText().catch(() => 'Page unavailable'));
        }
        throw e;
    } finally {
        fs.writeFileSync(out + 'ui-result.json', JSON.stringify(result, null, 2));
        fs.writeFileSync(out + 'ui-done', 'done');
        await browser.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
