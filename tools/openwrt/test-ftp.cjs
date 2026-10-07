const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const library = read('openwrt/files/usr/lib/freeisp/ftp.sh');
const init = read('openwrt/files/etc/init.d/freeisp-ftp');
const shell = process.env.FREEISP_TEST_SH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const run = (body, args = []) => spawnSync(shell, ['-s'], {
    input: `${library}\nlogger() { :; }\nset -- ${args.map(quote).join(' ')}\n${body}\n`, encoding: 'utf8', timeout: 10000
});
const temporary = name => {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    return fs.mkdtempSync(path.join(artifacts, name));
};
const shellPath = value => value.replaceAll('\\', '/').replace(/^([a-zA-Z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const config = args => {
    const result = run('freeisp_ftp_render "$@"', args);
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(result.stdout.trim().split('\n').map(line => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
    }));
};

test('FTP uses authenticated confined transfers with both passive and active data connections', () => {
    const rendered = config(['21', '0.0.0.0', '50000', '50009', '']);
    assert.equal(rendered.listen_port, '21');
    assert.equal(rendered.listen_address, '0.0.0.0');
    assert.equal(rendered.anonymous_enable, 'NO');
    assert.equal(rendered.local_enable, 'YES');
    assert.equal(rendered.userlist_enable, 'YES');
    assert.equal(rendered.userlist_deny, 'NO');
    assert.equal(rendered.guest_enable, 'YES');
    assert.equal(rendered.guest_username, 'freeisp-ftp');
    assert.equal(rendered.nopriv_user, 'freeisp-ftpd');
    assert.equal(rendered.chroot_local_user, 'YES');
    assert.equal(rendered.local_root, '/srv/freeisp');
    assert.equal(rendered.allow_writeable_chroot, 'NO');
    assert.equal(rendered.seccomp_sandbox, 'NO', 'OpenWrt musl needs the documented vsftpd timer compatibility setting');
    assert.equal(rendered.write_enable, 'YES');
    assert.equal(rendered.pasv_enable, 'YES');
    assert.equal(rendered.port_enable, 'YES');
    assert.equal(rendered.pasv_promiscuous, 'NO');
    assert.equal(rendered.port_promiscuous, 'NO');
    assert.equal(rendered.pasv_address, undefined);
});

test('custom bind, control port, passive range and advertised address render exactly', () => {
    const rendered = config(['2121', '10.77.0.1', '51000', '51020', '192.0.2.1']);
    assert.equal(rendered.listen_port, '2121');
    assert.equal(rendered.listen_address, '10.77.0.1');
    assert.equal(rendered.pasv_min_port, '51000');
    assert.equal(rendered.pasv_max_port, '51020');
    assert.equal(rendered.pasv_address, '192.0.2.1');
});

test('invalid or injected configuration fails before emitting any daemon configuration', () => {
    const cases = [
        ['0', '0.0.0.0', '50000', '50009', ''],
        ['65536', '0.0.0.0', '50000', '50009', ''],
        ['021', '0.0.0.0', '50000', '50009', ''],
        ['21', '10.0.0.256', '50000', '50009', ''],
        ['21', '10.00.0.1', '50000', '50009', ''],
        ['21', '0.0.0.0\nanonymous_enable=YES', '50000', '50009', ''],
        ['21', '::', '50000', '50009', ''],
        ['21', '0.0.0.0', '50009', '50000', ''],
        ['21', '0.0.0.0', '20', '30', ''],
        ['50000', '0.0.0.0', '50000', '50009', ''],
        ['21', '0.0.0.0', '50000', '65536', ''],
        ['21', '0.0.0.0', '50000', '50009', 'host.example'],
        ['21', '0.0.0.0', '50000', '50009', '1.2.3.4\n1.2.3.4']
    ];
    for (const args of cases) {
        const result = run('freeisp_ftp_render "$@"', args);
        assert.notEqual(result.status, 0, args.join(', '));
        assert.equal(result.stdout, '', 'failed config must produce no partial daemon configuration');
    }
});

test('blank, locked and missing root passwords prevent service startup', () => {
    const directory = temporary('ftp-password-test-');
    const shadow = path.join(directory, 'shadow');
    try {
        for (const hash of ['', '!', '*', '!$6$locked', 'x']) {
            fs.writeFileSync(shadow, `root:${hash}:0:0:99999:7:::\n`);
            assert.notEqual(run('freeisp_ftp_root_password_ready "$1"', [shellPath(shadow)]).status, 0);
        }
        fs.writeFileSync(shadow, 'somebody:x:0:0:99999:7:::\n');
        assert.notEqual(run('freeisp_ftp_root_password_ready "$1"', [shellPath(shadow)]).status, 0);
        // A deliberately unusable hash-shaped fixture; never an actual credential.
        fs.writeFileSync(shadow, 'root:$6$testfixture$not-a-real-hash:0:0:99999:7:::\n');
        assert.equal(run('freeisp_ftp_root_password_ready "$1"', [shellPath(shadow)]).status, 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('disabled service does not provision users, render config, or register a process', () => {
    const result = run(`${init.replace('. /usr/lib/freeisp/ftp.sh', '')}
config_load() { :; }
config_get_bool() { enabled=0; }
freeisp_ftp_prepare() { echo unexpected-prepare; return 1; }
procd_open_instance() { echo unexpected-process; return 1; }
start_service
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
});

test('enabled service registers the maintained daemon with procd and watches its UCI config', () => {
    const directory = temporary('ftp-init-test-');
    const portableDirectory = shellPath(directory);
    const fakeDaemon = `${portableDirectory}/vsftpd`;
    const shadow = `${portableDirectory}/shadow`;
    const runtime = `${portableDirectory}/run`;
    fs.writeFileSync(path.join(directory, 'vsftpd'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'shadow'), 'root:$6$testfixture$not-a-real-hash:0:0:99999:7:::\n');
    const mappedInit = init.replace('. /usr/lib/freeisp/ftp.sh', '')
        .replaceAll('/usr/sbin/vsftpd', fakeDaemon)
        .replaceAll('/etc/shadow', shadow)
        .replaceAll('/var/run/freeisp-ftp', runtime);
    try {
        const result = run(`${mappedInit}
config_load() { :; }
config_get_bool() { enabled=1; }
config_get() { case "$1" in port) port="$4";; listen_address) listen_address="$4";; passive_min_port) passive_min_port="$4";; passive_max_port) passive_max_port="$4";; passive_address) passive_address="$4";; esac; }
freeisp_ftp_prepare() { mkdir -p ${quote(runtime)}; }
procd_open_instance() { printf 'instance:%s\\n' "$1"; }
procd_set_param() { printf 'param:%s\\n' "$*"; }
procd_close_instance() { :; }
procd_add_reload_trigger() { printf 'trigger:%s\\n' "$1"; }
start_service || exit $?
service_triggers
`);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`param:command ${fakeDaemon} ${runtime}/vsftpd.conf`));
        assert.ok(result.stdout.includes('instance:main'));
        assert.ok(result.stdout.includes('trigger:freeisp_ftp'));
        assert.match(fs.readFileSync(path.join(directory, 'run/vsftpd.conf'), 'utf8'), /^listen_port=21$/m);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
