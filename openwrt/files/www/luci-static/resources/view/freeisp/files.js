'use strict';
'require view';
'require fs';
'require ui';
'require request';

var ROOT = '/srv/freeisp-files';
function validName(name) { return typeof name === 'string' && name !== '.' && name !== '..' && name.length > 0 && !/[\/\\\x00-\x1f\x7f]/.test(name); }
function size(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    var units = ['B', 'KiB', 'MiB', 'GiB'], i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (i ? bytes.toFixed(1) : bytes) + ' ' + units[i];
}

return view.extend({
    render: function() {
        var parts = [], entries = [], selected = null, busy = false, failure = '', active = 0;
        var readonly = !L.hasViewPermission();
        var search = E('input', {type: 'search', placeholder: 'Find in this folder', 'aria-label': 'Find files', input: draw});
        var table = E('div', {'class': 'if-table-wrap'}), summary = E('span', {'role': 'status'});
        var location = E('nav', {'class': 'files-location', 'aria-label': 'Folder path'});
        var panel = E('section', {id: 'files-panel', role: 'tabpanel', 'aria-labelledby': 'files-tab-0'});
        var tabs = E('div', {'class': 'if-tabs', role: 'tablist', 'aria-label': 'File sections'});
        function button(label, handler) { return E('button', {type: 'button', 'class': 'if-button', click: handler}, label); }
        function path() { return ROOT + (parts.length ? '/' + parts.join('/') : ''); }
        function notify(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'error'); }
        // Recheck ancestors before operations; never follow links from the listing.
        async function checkFolder() {
            var current = ROOT;
            if ((await fs.lstat(current)).type !== 'directory') throw new Error('The Files storage folder is unavailable.');
            for (var part of parts) {
                if (!validName(part)) throw new Error('Invalid folder name.');
                current += '/' + part;
                if ((await fs.lstat(current)).type !== 'directory') throw new Error('The folder changed. Refresh the file list.');
            }
        }
        async function read() {
            selected = null;
            try {
                await checkFolder();
                entries = (await fs.list(path())).filter(function(e) { return validName(e.name); });
                entries.sort(function(a, b) { return (b.type === 'directory') - (a.type === 'directory') || a.name.localeCompare(b.name); });
                failure = '';
            } catch (e) { entries = []; failure = 'Unable to load files. ' + (e.message || String(e)); }
        }
        async function run(action, onError) {
            if (busy) return;
            busy = true; draw();
            try { await action(); } catch (e) { (onError || notify)(e); }
            finally { busy = false; draw(); }
        }
        function refresh() { return run(read); }
        function navigate(next) {
            return run(async function() { parts = next; search.value = ''; await read(); });
        }
        function upload() {
            if (readonly || busy || failure) return;
            var picker = E('input', {type: 'file', id: 'files-upload-input'});
            var notice = E('p', {role: 'alert', 'class': 'if-error'});
            var submit = button('Upload file', async function() {
                var file = picker.files[0];
                if (!file || !validName(file.name)) { notice.textContent = 'Choose a file with a valid filename.'; return; }
                submit.disabled = true; notice.textContent = '';
                await run(async function() {
                    await checkFolder();
                    var existing = await fs.list(path());
                    if (existing.some(function(e) { return e.name === file.name; })) throw new Error('A file with this name already exists. Rename the local file before uploading.');
                    var data = new FormData();
                    data.append('sessionid', L.env.sessionid);
                    data.append('filename', path() + '/' + file.name);
                    data.append('filedata', file);
                    var response = await request.post(L.env.cgi_base + '/cgi-upload', data, {timeout: 0});
                    if (!response.ok) throw new Error('Upload failed. Check the connection and available storage.');
                    var reply = response.json();
                    if (reply.failure) throw new Error(reply.message || 'Upload failed.');
                    ui.hideModal();
                    await read();
                }, function(e) { notice.textContent = e.message || String(e); });
                submit.disabled = false;
            });
            ui.showModal('Upload to ' + (parts.join('/') || 'Files'), [
                E('label', {'for': picker.id}, 'Choose file'), picker,
                E('p', {'class': 'if-muted'}, 'The file keeps its name. Existing files are not replaced.'), notice,
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', function() { if (!busy) ui.hideModal(); }), submit])
            ]);
        }
        async function checkFile(entry) {
            await checkFolder();
            if (!entry || !validName(entry.name) || (await fs.lstat(path() + '/' + entry.name)).type !== 'file') throw new Error('This file changed. Refresh the file list.');
        }
        function download() {
            if (!selected || selected.type !== 'file') return;
            var entry = selected;
            return run(async function() {
                await checkFile(entry);
                var blob = await fs.read_direct(path() + '/' + entry.name, 'blob');
                var url = URL.createObjectURL(blob), link = E('a', {href: url, download: entry.name});
                document.body.appendChild(link); link.click(); link.remove();
                setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
            });
        }
        function remove() {
            if (readonly || busy || !selected || selected.type !== 'file') return;
            var entry = selected;
            var notice = E('p', {role: 'alert', 'class': 'if-error'});
            var confirm = button('Delete file', function() {
                if (busy) return;
                confirm.disabled = true; notice.textContent = '';
                return run(async function() {
                    await checkFile(entry);
                    await fs.remove(path() + '/' + entry.name);
                    ui.hideModal(); await read();
                }, function(e) { notice.textContent = e.message || String(e); }).finally(function() { confirm.disabled = false; });
            });
            ui.showModal('Delete file', [E('p', {}, 'Delete “' + entry.name + '”? This cannot be undone.'), notice,
                E('div', {'class': 'if-modal-actions'}, [button('Cancel', function() { if (!busy) ui.hideModal(); }), confirm])]);
        }
        var uploadButton = button('Upload…', upload), downloadButton = button('Download', download), deleteButton = button('Delete', remove);
        var refreshButton = button('Refresh', refresh);
        function backupLink(label) { return E('a', {'class': 'if-button', href: L.url('admin', 'system', 'flash')}, label); }
        var toolbar = E('div', {'class': 'if-toolbar files-toolbar'}, [deleteButton, downloadButton, backupLink('Backup…'), backupLink('Restore…'), uploadButton, refreshButton, search]);
        var footer = E('div', {'class': 'if-footer'}, [summary]);
        var help = E('p', {'class': 'if-help'}, 'Files are stored on this router in ' + ROOT + '. Backup and Restore open OpenWrt configuration tools. Modified shows the last file change; creation time is unavailable.');
        function draw() {
            uploadButton.disabled = readonly || busy || !!failure;
            deleteButton.disabled = readonly || busy || !selected || selected.type !== 'file';
            downloadButton.disabled = busy || !selected || selected.type !== 'file';
            refreshButton.disabled = busy;
            panel.setAttribute('aria-busy', String(busy));
            location.replaceChildren(button('Files', function() { navigate([]); }));
            parts.forEach(function(part, index) { location.append(' / ', button(part, function() { navigate(parts.slice(0, index + 1)); })); });
            location.querySelectorAll('button').forEach(function(b) { b.disabled = busy; });
            var query = search.value.toLowerCase(), visible = entries.filter(function(e) { return e.name.toLowerCase().indexOf(query) !== -1; });
            if (selected && !visible.includes(selected)) selected = null;
            deleteButton.disabled = readonly || busy || !selected || selected.type !== 'file';
            downloadButton.disabled = busy || !selected || selected.type !== 'file';
            var rows = visible.map(function(entry) {
                var folder = entry.type === 'directory', regular = entry.type === 'file';
                var choose = E('input', {type: 'radio', name: 'files-selection', 'aria-label': 'Select ' + entry.name,
                    change: function() { selected = entry; draw(); }});
                choose.checked = selected === entry; choose.disabled = busy || !regular;
                var name = folder ? button('▸ ' + entry.name, function() { navigate(parts.concat(entry.name)); }) : E('span', {}, entry.name);
                if (folder) name.disabled = busy;
                var modified = Number.isFinite(entry.mtime) && entry.mtime > 0 ? new Date(entry.mtime * 1000).toLocaleString() : '—';
                return E('tr', {'class': selected === entry ? 'files-selected' : ''}, [E('td', {}, choose), E('td', {}, name),
                    E('td', {}, folder ? 'Folder' : regular ? (entry.name.includes('.') ? entry.name.split('.').pop().toUpperCase() + ' file' : 'File') : entry.type + ' (unavailable)'),
                    E('td', {'class': 'files-size'}, regular ? size(entry.size) : '—'), E('td', {}, modified)]);
            });
            if (!rows.length) rows.push(E('tr', {}, E('td', {colspan: 5, 'class': 'if-empty', role: failure ? 'alert' : 'status'}, failure || (busy ? 'Loading files…' : query ? 'No matching files in this folder.' : 'This folder is empty. Upload a file to get started.'))));
            table.replaceChildren(E('table', {'class': 'if-table', 'aria-label': 'File list'}, [
                E('thead', {}, E('tr', {}, ['Select', 'File Name', 'Type', 'Size', 'Modified'].map(function(label) { return E('th', {scope: 'col'}, label); }))), E('tbody', {}, rows)
            ]));
            summary.textContent = failure ? 'Files unavailable · Refresh to retry' : visible.length + ' of ' + entries.length + ' items in this folder · ' + size(visible.reduce(function(total, e) { return total + (e.type === 'file' ? e.size || 0 : 0); }, 0)) + ' in listed files' + (readonly ? ' · Read only' : '');
        }
        function selectTab(index, focus) {
            active = index;
            Array.from(tabs.children).forEach(function(tab, i) { tab.setAttribute('aria-selected', String(active === i)); tab.tabIndex = active === i ? 0 : -1; });
            panel.setAttribute('aria-labelledby', 'files-tab-' + active);
            if (active === 0) panel.replaceChildren(toolbar, location, table, help, footer);
            else panel.replaceChildren(E('div', {'class': 'files-cloud'}, [E('h3', {}, 'Cloud Backup'), E('p', {}, 'Cloud backup is not configured in this build.'), E('p', {'class': 'if-muted'}, 'Use Backup to download an OpenWrt configuration archive and keep it in your own storage.'), backupLink('Open backup tools')]));
            if (focus) tabs.children[active].focus();
        }
        ['File', 'Cloud Backup'].forEach(function(label, index) {
            tabs.appendChild(E('button', {type: 'button', 'class': 'if-button', role: 'tab', id: 'files-tab-' + index, 'aria-controls': 'files-panel',
                click: function() { selectTab(index, false); }, keydown: function(e) {
                    var next = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? 1 - index : e.key === 'Home' ? 0 : e.key === 'End' ? 1 : -1;
                    if (next !== -1) { e.preventDefault(); selectTab(next, true); }
                }}, label));
        });
        selectTab(0, false); refresh();
        return E('div', {'class': 'if-window files-window'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/files.css') + '?v=1'}),
            E('div', {'class': 'if-heading'}, E('div', {}, [E('h2', {}, 'Files'), E('p', {}, 'Router files, uploads and configuration backups.')])),
            E('div', {'class': 'if-card'}, [tabs, panel])
        ]);
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
