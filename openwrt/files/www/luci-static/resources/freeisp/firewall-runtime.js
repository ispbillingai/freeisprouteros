'use strict';
'require baseclass';
'require fs';

// nft JSON schema: https://netfilter.org/projects/nftables/manpage.html
// /proc conntrack and `conntrack -L -o extended` share the two-tuple format.
function number(value) {
	if (value === null || value === undefined || value === '') return null;
	var n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function expression(value) {
	if (value === null) return '';
	if (typeof value !== 'object') return String(value);
	if (Array.isArray(value)) return value.map(expression).join(', ');
	if (value.payload) return [value.payload.protocol, value.payload.field].filter(Boolean).join(' ');
	if (value.meta) return 'meta ' + value.meta.key;
	if (value.ct) return 'ct ' + value.ct.key;
	if (value.prefix) return expression(value.prefix.addr) + '/' + value.prefix.len;
	if (value.set) return '{ ' + expression(value.set) + ' }';
	if (value.range) return value.range.map(expression).join('-');
	if (value.match) return expression(value.match.left) + ' ' + value.match.op + ' ' + expression(value.match.right);
	if (value.jump || value.goto) return (value.jump ? 'jump ' : 'goto ') + (value.jump || value.goto).target;
	for (var i = 0, verdicts = ['accept', 'drop', 'return', 'continue', 'notrack']; i < verdicts.length; i++)
		if (Object.prototype.hasOwnProperty.call(value, verdicts[i])) return verdicts[i];
	if (Object.prototype.hasOwnProperty.call(value, 'reject')) return 'reject' + (value.reject ? ' ' + JSON.stringify(value.reject) : '');
	if (Object.prototype.hasOwnProperty.call(value, 'masquerade')) return 'masquerade';
	return JSON.stringify(value);
}

function parseNft(raw) {
	var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!data || !Array.isArray(data.nftables)) throw new Error('Invalid nftables JSON response.');
	var named = Object.create(null);
	data.nftables.forEach(function(item) {
		if (item.counter && item.counter.family === 'inet' && item.counter.table === 'fw4') named[item.counter.name] = item.counter;
	});
	return data.nftables.filter(function(item) {
		return item.rule && item.rule.family === 'inet' && item.rule.table === 'fw4';
	}).map(function(item) {
		var rule = item.rule, counter = null;
		var expr = Array.isArray(rule.expr) ? rule.expr : [];
		expr.some(function(statement) {
			if (!statement || !Object.prototype.hasOwnProperty.call(statement, 'counter')) return false;
			counter = typeof statement.counter === 'string' ? named[statement.counter] : statement.counter;
			return !!counter;
		});
		return {
			chain: rule.chain || '', handle: number(rule.handle), comment: rule.comment || '',
			packets: counter ? number(counter.packets) : null, bytes: counter ? number(counter.bytes) : null,
			expression: expr.filter(function(statement) { return !Object.prototype.hasOwnProperty.call(statement, 'counter'); }).map(expression).join(' ')
		};
	});
}

function endpoint(address, port) {
	if (!address) return '';
	return port == null ? address : (address.indexOf(':') >= 0 ? '[' + address + ']' : address) + ':' + port;
}

function parseConnections(raw) {
	var rows = [], invalid = 0;
	String(raw || '').split(/\r?\n/).forEach(function(line) {
		if (!line.trim()) return;
		var head = line.match(/^(?:(ipv[46])\s+\d+\s+)?(\S+)\s+\d+\s+(\d+)\s+(.*)$/);
		if (!head) { invalid++; return; }
		var tuples = [{}, {}], tuple = 0, tail = head[4], match;
		var pairs = /\b(src|dst|sport|dport|packets|bytes)=([^\s]+)/g;
		while ((match = pairs.exec(tail))) {
			if (match[1] === 'src' && tuples[0].src) tuple = 1;
			tuples[tuple][match[1]] = match[2];
		}
		if (!tuples[0].src || !tuples[0].dst) { invalid++; return; }
		var original = tuples[0], reply = tuples[1];
		var state = (tail.match(/^([A-Z_]+)\b/) || [])[1] || (tail.match(/\[(UNREPLIED|ASSURED)\]/) || [])[1] || '';
		var originalBytes = number(original.bytes), replyBytes = number(reply.bytes);
		var originalPackets = number(original.packets), replyPackets = number(reply.packets);
		rows.push({
			family: head[1] || (original.src.indexOf(':') >= 0 ? 'ipv6' : 'ipv4'), protocol: head[2],
			source: endpoint(original.src, original.sport), destination: endpoint(original.dst, original.dport),
			replySource: endpoint(reply.src, reply.sport), replyDestination: endpoint(reply.dst, reply.dport),
			state: state, expires: number(head[3]),
			bytes: originalBytes === null || replyBytes === null ? null : originalBytes + replyBytes,
			packets: originalPackets === null || replyPackets === null ? null : originalPackets + replyPackets
		});
	});
	return { rows: rows, invalid: invalid };
}

function parseHelpers(raw, loaded, installed) {
	var rows = [], current;
	String(raw || '').split(/\r?\n/).forEach(function(line) {
		if (/^\s*config\s+helper(?:\s|$)/.test(line)) { current = {}; rows.push(current); return; }
		var m = line.match(/^\s*option\s+(\w+)\s+(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*(?:#.*)?$/);
		if (current && m && ['name', 'description', 'module', 'family', 'proto', 'port'].indexOf(m[1]) >= 0)
			current[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
	});
	var modules = String(loaded || '').split(/\r?\n/).map(function(line) { return line.split(/\s+/)[0]; });
	var files = String(installed || '').split(/\r?\n/).map(function(path) { return path.split('/').pop().replace(/\.ko(?:\..*)?$/, ''); });
	return rows.filter(function(row) { return !!row.name; }).map(function(row) {
		row.loaded = modules.indexOf(row.module) >= 0;
		row.available = row.loaded || files.indexOf(row.module) >= 0;
		return row;
	});
}

function parseSnapshot(raw) {
	var snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!snapshot || snapshot.error) throw new Error(snapshot && snapshot.error || 'Empty firewall status response.');
	var result = { rules: [], connections: [], helpers: [], errors: [] };
	function source(name, title, parse) {
		var part = snapshot[name];
		if (!part || part.code !== 0) {
			result.errors.push(title + ': ' + (part && part.stderr || 'The status source is unavailable.'));
			return;
		}
		try { parse(part); }
		catch (error) { result.errors.push(title + ': ' + error.message); }
	}
	source('nft', 'Live firewall rules', function(part) { result.rules = parseNft(part.stdout); });
	source('connections', 'Connections', function(part) {
		var parsed = parseConnections(part.stdout);
		result.connections = parsed.rows;
		if (parsed.invalid) result.errors.push('Connections: ' + parsed.invalid + ' unrecognized entries were omitted.');
		if (part.truncated) result.errors.push('Connections: showing the first ' + (number(part.limit) || 5000) + ' entries.');
	});
	source('helpers', 'Service helpers', function(part) {
		result.helpers = parseHelpers(part.stdout, snapshot.modules, snapshot.installedModules);
		if (String(part.stdout || '').trim() && !result.helpers.length) result.errors.push('Service helpers: the catalogue format was not recognized.');
	});
	return result;
}

return baseclass.extend({
	parseNft: parseNft,
	parseConnections: parseConnections,
	parseHelpers: parseHelpers,
	parseSnapshot: parseSnapshot,
	load: function() {
		return fs.exec('/usr/bin/freeisp-firewall-status', []).then(function(response) {
			if (!response || response.code !== 0) throw new Error(response && response.stderr || 'The read-only firewall status command failed.');
			return parseSnapshot(response.stdout);
		}).catch(function(error) {
			return { rules: [], connections: [], helpers: [], errors: ['Firewall monitoring: ' + error.message] };
		});
	}
});
