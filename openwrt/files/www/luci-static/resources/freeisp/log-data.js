'use strict';
'require baseclass';

var facilities = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console', 'cron', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
var severities = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];
return baseclass.extend({
    severities: severities,
    parse: function(reply) {
        // A failed or incompatible RPC must never look like an empty buffer.
        if (!reply || !Array.isArray(reply.log)) throw new Error('The router returned an invalid log response.');
        return reply.log.map(function(entry) {
            if (!entry || typeof entry.msg !== 'string') throw new Error('The router returned an invalid log entry.');
            var valid = Number.isInteger(entry.priority) && entry.priority >= 0 && entry.priority <= 191;
            var facility = valid ? facilities[Math.floor(entry.priority / 8)] : 'unknown';
            var severity = valid ? severities[entry.priority % 8] : 'unknown';
            var date = typeof entry.time === 'number' ? new Date(entry.time) : new Date(NaN);
            var tag = entry.msg.match(/^([\w./-]+)(?:\[\d+\])?:\s*/);
            return {
                id: entry.id == null ? '—' : String(entry.id),
                time: isNaN(date.getTime()) ? 'Unknown' : date.toISOString().replace('T', ' ').replace('Z', ''),
                facility: facility, severity: severity,
                topics: [facility, severity].concat(tag ? [tag[1]] : []).join(', '),
                message: entry.msg
            };
        });
    },
    filter: function(rows, query, severity, facility) {
        query = query.trim().toLowerCase();
        return rows.filter(function(row) {
            return (!severity || row.severity === severity) && (!facility || row.facility === facility) &&
                (!query || [row.id, row.time, row.topics, row.message].join(' ').toLowerCase().indexOf(query) !== -1);
        });
    },
    text: function(rows) {
        return rows.map(function(row) { return row.id + ' ' + row.time + ' UTC ' + row.topics + ': ' + row.message; }).join('\n') + (rows.length ? '\n' : '');
    }
});
