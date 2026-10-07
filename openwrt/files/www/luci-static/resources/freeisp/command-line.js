'use strict';
'require baseclass';

/* Router-style grammar and command registry, independent of the transport/UI.
 * No input is evaluated as JavaScript, shell code or RouterOS script. */
function tokenize(line) {
    if (line.length > 2048 || /[\x00-\x1f\x7f]/.test(line)) throw new Error('Enter one command, up to 2048 characters.');
    var words = [], word = '', quote = '', escape = false, started = false;
    for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (escape) { word += c; escape = false; started = true; }
        else if (c === '\\') { escape = true; started = true; }
        else if (quote) { if (c === quote) quote = ''; else word += c; }
        else if (c === '"' || c === "'") { quote = c; started = true; }
        else if (/\s/.test(c)) { if (started) words.push(word); word = ''; started = false; }
        else { word += c; started = true; }
    }
    if (quote || escape) throw new Error('Unfinished quote or escape.');
    if (started) words.push(word);
    return words;
}
function table(rows, keys) {
    if (!rows.length) return '(no entries)';
    keys = keys || Object.keys(rows[0]);
    var cells = [keys.map(function(k) { return k.toUpperCase(); })].concat(rows.map(function(row) {
        return keys.map(function(k) { var v = row[k]; return v == null ? '-' : Array.isArray(v) ? v.join(', ') : String(v); });
    }));
    var widths = keys.map(function(_, i) { return Math.max.apply(null, cells.map(function(row) { return row[i].length; })); });
    return cells.map(function(row) { return row.map(function(v, i) { return v.padEnd(widths[i]); }).join('  ').trimEnd(); }).join('\n');
}
function properties(value) { return Object.keys(value).map(function(k) { return k + ': ' + value[k]; }).join('\n'); }
function options(args, allowed) {
    var result = Object.create(null);
    args.forEach(function(arg) {
        var at = arg.indexOf('='), key = arg.slice(0, at), value = arg.slice(at + 1);
        if (at < 1 || !allowed.includes(key) || Object.prototype.hasOwnProperty.call(result, key)) throw new Error('Expected ' + allowed.map(function(k) { return k + '=value'; }).join(' ') + '.');
        result[key] = value;
    });
    return result;
}
function noArgs(args) { if (args.length) throw new Error('Unexpected arguments: ' + args.join(' ')); }
function match(word, names) {
    if (names.includes(word)) return word;
    var matches = names.filter(function(n) { return n.indexOf(word) === 0; });
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous word "' + word + '": ' + matches.join(', ') : 'Unknown command or menu "' + word + '". Type ? for help.');
    return matches[0];
}
function create(backend) {
    var path = [], commands = Object.create(null), menus = {'': []}, identityDraft = null;
    function add(name, description, run) {
        var parts = name.split(' '), verb = parts.pop();
        commands[name] = {description: description, run: run};
        for (var i = 0; i <= parts.length; i++) {
            var key = parts.slice(0, i).join(' ');
            if (!menus[key]) menus[key] = [];
            var child = i < parts.length ? parts[i] : verb;
            if (!menus[key].includes(child)) menus[key].push(child);
        }
    }
    function readonly() { if (!backend.canWrite()) throw new Error('This session has read-only access.'); }
    function listing(name, description, load, keys) {
        add(name + ' print', description, async function(args) {
            var detail = args[0] === 'detail'; if (detail) args = args.slice(1);
            var filters = {};
            if (args.length) {
                if (args[0] !== 'where' || args.length === 1) throw new Error('Use print [detail] [where property=value].');
                filters = options(args.slice(1), keys);
            }
            var rows = (await load()).filter(function(row) { return Object.keys(filters).every(function(k) { return String(row[k]) === filters[k]; }); });
            return detail ? rows.map(properties).join('\n\n') || '(no entries)' : table(rows, keys);
        });
    }
    add('system resource print', 'Live uptime, memory, model and release', async function(args) { noArgs(args); return properties(await backend.resources()); });
    add('system identity print', 'Router identity', async function(args) { noArgs(args); return 'name: ' + await backend.identity() + (identityDraft ? '\npending-name: ' + identityDraft.name : ''); });
    add('system identity set', 'Stage identity: set name=FreeISP; then /apply', async function(args) {
        readonly(); var values = options(args, ['name']), name = values.name;
        if (!name || name.length > 63 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name)) throw new Error('Name must be 1–63 letters, digits or hyphens, starting and ending with a letter or digit.');
        identityDraft = {name: name, original: identityDraft ? identityDraft.original : await backend.identity()};
        return 'Staged name=' + name + '. Use /pending to review, /apply to save, or /discard.';
    });
    listing('interface', 'Live physical and virtual devices', function() { return backend.devices(); }, ['name', 'type', 'running', 'mtu', 'mac-address']);
    listing('interface ethernet', 'Live Ethernet devices', async function() { return (await backend.devices()).filter(function(d) { return d.type === 'ethernet'; }); }, ['name', 'running', 'mtu', 'mac-address']);
    listing('interface bridge', 'Configured bridges', function() { return backend.bridges(); }, ['name', 'ports']);
    listing('interface vlan', 'Configured VLAN devices', function() { return backend.vlans(); }, ['name', 'interface', 'vlan-id', 'type']);
    listing('ip address', 'Live IPv4 addresses', function() { return backend.addresses(false); }, ['address', 'interface', 'device']);
    listing('ipv6 address', 'Live IPv6 addresses', function() { return backend.addresses(true); }, ['address', 'interface', 'device']);
    listing('ip dns', 'Current upstream DNS by interface', function() { return backend.dns(); }, ['interface', 'servers']);
    add('ip route print', 'Live IPv4 routing table', async function(args) { noArgs(args); return backend.execute('routes4', []); });
    add('ipv6 route print', 'Live IPv6 routing table', async function(args) { noArgs(args); return backend.execute('routes6', []); });
    add('log print', 'Last 100 router log messages', async function(args) { noArgs(args); return backend.execute('log', []); });
    add('ping', 'ping address=1.1.1.1 count=4 (1–5 packets)', async function(args) {
        if (args[0] && !args[0].includes('=')) args = ['address=' + args[0]].concat(args.slice(1));
        var values = options(args, ['address', 'count']), host = values.address || '', count = values.count || '4';
        if (host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(host)) throw new Error('Enter a valid hostname or IP address.');
        if (!/^[1-5]$/.test(count)) throw new Error('Count must be between 1 and 5.');
        return backend.execute('ping', [host, count]);
    });
    add('pending', 'Review changes staged in this Command Line', function(args) { noArgs(args); return identityDraft ? 'system identity: ' + identityDraft.original + ' -> ' + identityDraft.name : 'No Command Line changes pending.'; });
    add('discard', 'Discard changes staged in this Command Line', function(args) { noArgs(args); identityDraft = null; return 'Command Line draft discarded.'; });
    add('apply', 'Save staged changes using OpenWrt rollback protection', async function(args) {
        noArgs(args); readonly(); if (!identityDraft) return 'No Command Line changes pending.';
        await backend.applyIdentity(identityDraft); identityDraft = null;
        return 'Changes submitted. Follow the OpenWrt apply status to confirm completion.';
    });
    add('clear', 'Clear the screen', function(args) { noArgs(args); return {clear: true}; });
    function help(at) {
        return 'Menu: /' + at.join('/') + '\n' + menus[at.join(' ')].map(function(n) {
            var full = at.concat(n).join(' ');
            return '  ' + n.padEnd(14) + (commands[full] ? commands[full].description : 'Open /' + full.replace(/ /g, '/'));
        }).join('\n') + '\n\n/ = root   .. = parent   Tab = complete   ↑/↓ = history\nAbsolute paths work anywhere. FreeISP supports the commands listed here; RouterOS scripts are not supported.';
    }
    function resolve(words, absolute) {
        var at = absolute ? [] : path.slice(), consumed = 0;
        for (; consumed < words.length; consumed++) {
            var word = words[consumed];
            if (word === '..') { at.pop(); continue; }
            if (word === '.') continue;
            if (word === '?' || word === 'help') return {help: at};
            var key = at.join(' '), names = menus[key];
            if (!names) break;
            // Root utility commands also work while inside a menu.
            if (consumed === 0 && !absolute && commands[word]) at = [];
            at.push(match(word, menus[at.join(' ')]));
            if (commands[at.join(' ')]) { consumed++; break; }
        }
        return {at: at, args: words.slice(consumed), command: commands[at.join(' ')]};
    }
    function split(line) {
        var words = tokenize(line.trim()), absolute = /^\//.test(line.trim());
        // Expand only path words, never slash characters inside property values.
        var expanded = [], commandSeen = false;
        words.forEach(function(w) {
            if (!commandSeen && !w.includes('=')) expanded.push.apply(expanded, w.split('/').filter(Boolean)); else expanded.push(w);
            if (w.includes('=') || ['print', 'set', 'ping'].includes(w)) commandSeen = true;
        });
        return {words: expanded, absolute: absolute};
    }
    return {
        path: function() { return '/' + path.join('/'); },
        hasDraft: function() { return identityDraft !== null; },
        help: function() { return help(path); },
        run: async function(line) {
            if (!line.trim()) return '';
            var parsed = split(line), result = resolve(parsed.words, parsed.absolute);
            if (result.help) return help(result.help);
            if (result.command) {
                if (result.args.length === 1 && (result.args[0] === '?' || result.args[0] === 'help')) return result.command.description;
                return result.command.run(result.args);
            }
            if (result.args.length) throw new Error('Unexpected arguments.');
            path = result.at; return '';
        },
        complete: function(line) {
            try {
                var parsed = split(line), words = parsed.words, trailing = /[\s/]$/.test(line), prefix = trailing ? '' : (words.pop() || '');
                var result = resolve(words, parsed.absolute), at = result.at;
                if (!at || result.command) return {line: line, choices: []};
                var choices = menus[at.join(' ')].filter(function(n) { return n.indexOf(prefix) === 0; });
                if (choices.length === 1) {
                    var base = trailing ? line : line.slice(0, line.length - prefix.length);
                    return {line: base + choices[0] + ' ', choices: []};
                }
                return {line: line, choices: choices};
            } catch(e) { return {line: line, choices: []}; }
        }
    };
}
return baseclass.extend({create: create, tokenize: tokenize});
