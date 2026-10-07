'use strict';
'require baseclass';

// SQM stores rates in decimal kbit/s. Zero disables that direction's shaper.
function limit(value) {
    if (value == null || !/^\d+$/.test(String(value))) return '—';
    var rate = Number(value);
    if (!Number.isSafeInteger(rate)) return '—';
    if (rate === 0) return 'Shaping off';
    if (rate >= 1000000) return (rate / 1000000) + ' Gbps';
    if (rate >= 1000) return (rate / 1000) + ' Mbps';
    return rate + ' kbps';
}

function queues(values) {
    return Object.keys(values || {}).filter(function(id) {
        return values[id] && values[id]['.type'] === 'queue';
    }).map(function(id) {
        var s = values[id];
        return {name: id, enabled: s.enabled === '1', device: s.interface || '—',
            upload: limit(s.upload), download: limit(s.download),
            qdisc: s.qdisc || '—', script: s.script || '—'};
    });
}

function types(rows, inventory) {
    var names = new Set((inventory || []).map(function(entry) { return entry.name; }).filter(Boolean));
    rows.forEach(function(row) { if (row.qdisc !== '—') names.add(row.qdisc); });
    return Array.from(names).sort().map(function(name) {
        return {name: name, available: inventory === null ? null : inventory.some(function(entry) { return entry.name === name; }),
            queues: rows.filter(function(row) { return row.qdisc === name; }).map(function(row) { return row.name; })};
    });
}

function validate(values, sections, devices, inventory, scripts, id) {
    var name = id || values.name;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name || '')) throw new Error('Use a queue name starting with a letter, with up to 32 letters, digits or underscores.');
    if (!id && sections[name]) throw new Error('A section with this name already exists.');
    if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(values.interface || '') || values.interface === 'lo') throw new Error('Select a valid network device.');
    if (values.enabled === '1' && !devices[values.interface]) throw new Error('This device is unavailable. Refresh before enabling its queue.');
    ['upload', 'download'].forEach(function(key) {
        if (!/^\d+$/.test(values[key]) || Number(values[key]) > 2147483647) throw new Error('Enter upload and download as whole kbit/s values from 0 to 2147483647.');
    });
    if (values.enabled === '1' && !Number(values.upload) && !Number(values.download)) throw new Error('Set at least one nonzero rate before enabling this queue.');
    if (!inventory.some(function(q) { return q.name === values.qdisc; })) throw new Error('Select an available queue type.');
    if (!scripts.some(function(s) { return s.name === values.script && /^[A-Za-z0-9_-]+\.qos$/.test(s.name); })) throw new Error('Select an installed SQM setup script.');
    if (values.enabled !== '0' && values.enabled !== '1') throw new Error('Invalid enabled setting.');
    if (values.enabled === '1' && Object.keys(sections).some(function(key) {
        var s = sections[key]; return key !== id && s['.type'] === 'queue' && s.enabled === '1' && s.interface === values.interface;
    })) throw new Error('Another enabled queue already uses this interface.');
    return {interface: values.interface, enabled: values.enabled, upload: String(Number(values.upload)),
        download: String(Number(values.download)), qdisc: values.qdisc, script: values.script};
}

function operations(before, after) {
    var ops = [], fields = ['interface', 'enabled', 'upload', 'download', 'qdisc', 'script'];
    Object.keys(before).forEach(function(id) { if (before[id]['.type'] === 'queue' && !after[id]) ops.push({kind: 'remove', id: id}); });
    Object.keys(after).forEach(function(id) {
        if (after[id]['.type'] !== 'queue') return;
        var values = {};
        fields.forEach(function(key) { if (!before[id] || before[id][key] !== after[id][key]) values[key] = after[id][key]; });
        if (!before[id] || Object.keys(values).length) ops.push({kind: before[id] ? 'set' : 'add', id: id, values: values});
    });
    return ops;
}

function stage(uci, ops) {
    ops.forEach(function(op) {
        if (op.kind === 'remove') uci.remove('sqm', op.id);
        else {
            var id = op.kind === 'add' ? uci.add('sqm', 'queue', op.id) : op.id;
            Object.keys(op.values).forEach(function(key) { uci.set('sqm', id, key, op.values[key]); });
        }
    });
}

function runtime(device, qdiscs) {
    if (qdiscs === null) return {label: 'Unknown', bytes: '—'};
    var root = qdiscs.filter(function(q) { return q.dev === device && q.root; })[0];
    if (!root) return {label: 'No root queue observed', bytes: '—'};
    var rate = root.options && root.options.bandwidth;
    return {label: root.kind + (typeof rate === 'number' && rate > 0 ? ' · ' + limit(String(rate * 8 / 1000)) : ' · root qdisc'),
        bytes: typeof root.bytes === 'number' ? String(root.bytes) : '—'};
}

return baseclass.extend({limit: limit, queues: queues, types: types, validate: validate, operations: operations, stage: stage, runtime: runtime});
