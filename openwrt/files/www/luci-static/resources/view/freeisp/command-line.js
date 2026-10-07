'use strict';
'require view';
'require freeisp.command-line as commandLine';
'require freeisp.command-line-backend as backendModule';

return view.extend({
    render: function() {
        var backend = backendModule.create(), cli = commandLine.create(backend), hostname = 'router';
        var busy = false, history = [], historyIndex = 0, draftInput = '';
        var output = E('div', {'class': 'cl-output', role: 'log', 'aria-label': 'Command output', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0'});
        var prompt = E('span', {'class': 'cl-prompt', 'aria-hidden': 'true'});
        var state = E('span', {'class': 'cl-state', role: 'status'}, 'Connecting…');
        var input = E('input', {type: 'text', 'class': 'cl-input', 'aria-label': 'Command', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '2048'});
        var run = E('button', {type: 'submit', 'class': 'cl-button cl-run'}, 'Run');
        function promptText() { return '[' + (L.env.username || 'user') + '@' + hostname + '] ' + (cli.path() === '/' ? '' : cli.path()) + '> '; }
        function updatePrompt() { prompt.textContent = promptText(); }
        function append(text, kind) {
            if (!text) return;
            output.appendChild(E('pre', {'class': kind || ''}, String(text).slice(0, 65536)));
            while (output.childNodes.length > 200) output.removeChild(output.firstChild);
            output.scrollTop = output.scrollHeight;
        }
        async function execute(line) {
            if (busy || !line.trim()) return;
            busy = true; input.disabled = true; run.disabled = true; state.textContent = 'Running…';
            append(promptText() + line, 'cl-echo'); input.value = '';
            if (history[history.length - 1] !== line) history.push(line);
            if (history.length > 100) history.shift(); historyIndex = history.length; draftInput = '';
            try {
                var result = await cli.run(line);
                if (result && result.clear) output.replaceChildren(); else append(result);
                state.textContent = cli.hasDraft() ? 'Changes staged · /pending' : 'Ready';
            } catch(e) { append('error: ' + (e.message || String(e)), 'cl-error'); state.textContent = 'Command failed'; }
            finally { busy = false; input.disabled = false; run.disabled = false; updatePrompt(); input.focus(); }
        }
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Tab') {
                e.preventDefault(); var result = cli.complete(input.value); input.value = result.line;
                if (result.choices.length) append(result.choices.join('  '), 'cl-hint');
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (historyIndex === history.length) draftInput = input.value;
                historyIndex = Math.max(0, Math.min(history.length, historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
                input.value = historyIndex === history.length ? draftInput : history[historyIndex];
                input.setSelectionRange(input.value.length, input.value.length);
            } else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); output.replaceChildren(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) { e.preventDefault(); input.value = ''; }
        });
        input.addEventListener('paste', function(e) {
            var text = e.clipboardData.getData('text');
            if (/[\r\n]/.test(text)) { e.preventDefault(); append('Paste one command at a time. Multiline scripts are not supported.', 'cl-error'); }
        });
        var form = E('form', {'class': 'cl-command', submit: function(e) { e.preventDefault(); execute(input.value); }}, [prompt, input, run]);
        var root = E('section', {'class': 'cl-window'}, [
            E('link', {rel: 'stylesheet', href: L.resource('freeisp/command-line.css') + '?v=1'}),
            E('div', {'class': 'cl-heading'}, [E('div', {}, [E('h2', {}, 'Command Line'), E('p', {}, 'Router commands, live diagnostics and configuration.')]), state]),
            E('div', {'class': 'cl-console'}, [E('div', {'class': 'cl-toolbar'}, [E('span', {}, 'FreeISP / OpenWrt'),
                E('button', {type: 'button', 'class': 'cl-button', click: function() { append(cli.help(), 'cl-hint'); input.focus(); }}, 'Help'),
                E('button', {type: 'button', 'class': 'cl-button', click: function() { output.replaceChildren(); input.focus(); }}, 'Clear')]), output, form]),
            E('p', {'class': 'cl-footer'}, 'Tab to complete · ↑ / ↓ for history · ? for help · / to return to root. Identity edits are staged until /apply. History stays in this page only.')
        ]);
        append('FreeISP Command Line\n\nHierarchical router commands on OpenWrt. Type ? to see supported commands.\nTry /system resource print, /interface print or /ip address print.\nUse ping 1.1.1.1 count=4 for a bounded connectivity check.\n');
        updatePrompt();
        backend.identity().then(function(name) { hostname = name; updatePrompt(); if (!busy) state.textContent = 'Ready'; }).catch(function(e) { append('Connection failed: ' + (e.message || e) + '. Check your session and reload.', 'cl-error'); state.textContent = 'Connection failed'; });
        window.addEventListener('beforeunload', function(e) { if (cli.hasDraft()) { e.preventDefault(); e.returnValue = ''; } });
        document.addEventListener('uci-applied', function() { window.location.reload(); }, {once: true});
        return root;
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
