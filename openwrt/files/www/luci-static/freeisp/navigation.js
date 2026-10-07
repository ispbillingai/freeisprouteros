/* FreeISP navigation; underlying settings are the original LuCI views. */
(function() {
    document.querySelectorAll('link[rel="stylesheet"]').forEach(function(link) {
        if (/\/freeisp(?:-night)?\/cascade\.css/.test(link.href)) {
            var url = new URL(link.href); url.searchParams.set('freeisp','day-night-2'); link.href = url.href;
        }
    });
    var theme;
    try { theme = localStorage.getItem('freeisp-theme'); } catch(e) {}
    if (theme === 'day' || theme === 'night') document.documentElement.dataset.freeispTheme = theme;
})();
document.addEventListener('DOMContentLoaded', function() {
    if (document.querySelector('input[name="luci_password"]')) return;
    if (location.pathname.indexOf('/cgi-bin/luci/admin/wifi') === 0) {
        var wifiScript = document.createElement('script');
        wifiScript.src = '/luci-static/freeisp/wifi-navigation.js?v=1';
        document.head.appendChild(wifiScript);
    }
    var sidebar = document.createElement('nav');
    sidebar.className = 'freeisp-sidebar';
    sidebar.setAttribute('aria-label', 'Router navigation');
    var logo = document.createElement('div');
    logo.className = 'fi-logo';
    logo.innerHTML = '<span class="freeisp-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>FreeISP Desk</span>';
    sidebar.appendChild(logo);
    var paths = [
        'M5 3v7h14v11M2 3h6M16 21h6',
        'M4 18V9m8 9V3m8 15v-6',
        'M3 4h18v12H3zM8 21h8m-4-5v5',
        'M3 5h6v6H3zM15 13h6v6h-6zM9 8h9v5',
        'M8 5H3v5h5zM21 14h-5v5h5zM8 8h4v9h4',
        'M3 6h18M3 12h18M3 18h18M7 3v6m10 0v6m-8 0v6',
        'M4 4h16v16H4zM8 8h8m-8 4h8m-8 4h5'
    ];
    var activeAssigned = false;
    var entries = [
        ['Workspace', null], ['Quick Set', 'freeisp'], ['Overview', 'status/overview'], ['WiFi', 'wifi/interfaces'],
        ['Network', null], ['Interfaces', 'network/freeisp_interfaces'], ['Bridge / VLAN', 'network/freeisp_bridge'],
        ['PPPoE', 'network/freeisp_pppoe'], ['Hotspot', 'network/freeisp_hotspot'], ['Firewall', 'network/freeisp_firewall'], ['IP · DHCP', 'network/dhcp'], ['IP · DNS', 'network/dns'], ['IP Service', 'network/freeisp_ip_service'],
        ['Routing', 'network/routes'], ['Queues', 'network/freeisp_queues'],
        ['Bandwidth', 'services/nlbw/display'], ['Administration', null],
        ['System', 'system/system'], ['Files', 'system/freeisp_files'], ['Log', 'status/freeisp_log'],
        ['Tools', 'network/freeisp_tools'], ['Command Line', 'system/freeisp_command_line'], ['Software', 'system/package-manager'], ['Logout', 'logout']
    ];
    entries.forEach(function(item) {
        var element = document.createElement(item[1] ? 'a' : 'span');
        element.textContent = item[0];
        if (item[1]) {
            var svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
            svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('class','fi-nav-icon'); svg.setAttribute('aria-hidden','true');
            var path = document.createElementNS('http://www.w3.org/2000/svg','path');
            path.setAttribute('d',paths[sidebar.querySelectorAll('a').length % paths.length]);
            path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor'); path.setAttribute('stroke-width','1.6'); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round');
            svg.appendChild(path); element.prepend(svg);
            element.href = '/cgi-bin/luci/admin/' + item[1];
            if (!activeAssigned && (location.pathname === element.pathname || (item[1] === 'wifi/interfaces' && /^\/cgi-bin\/luci\/admin\/wifi(?:\/|$)/.test(location.pathname)))) { element.classList.add('active'); element.setAttribute('aria-current','page'); activeAssigned = true; }
        } else element.className = 'group';
        sidebar.appendChild(element);
    });
    var more = document.createElement('button');
    more.textContent = 'All OpenWrt menus';
    more.onclick = function() { document.body.classList.toggle('freeisp-allmenus'); };
    sidebar.appendChild(more);
    document.body.appendChild(sidebar);
    document.body.classList.add('freeisp-desktop');
    var header = document.querySelector('header');
    if (header) {
        var brand = header.querySelector('.brand');
        if (brand) brand.textContent = 'Workspace / ' + ((sidebar.querySelector('a.active') || {}).textContent || 'FreeISP');
        var toggle = document.createElement('div'); toggle.className='fi-theme-switch'; toggle.setAttribute('aria-label','Appearance');
        function setTheme(theme, persist) {
            document.documentElement.dataset.freeispTheme=theme;
            if (persist) { try { localStorage.setItem('freeisp-theme',theme); } catch(e) {} }
            toggle.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.theme===theme));});
        }
        ['day','night'].forEach(function(theme){var b=document.createElement('button'); b.type='button';b.dataset.theme=theme;b.textContent=theme==='day'?'☀ Day':'☾ Night';b.setAttribute('aria-label',theme==='day'?'Use Day theme':'Use Night theme');b.onclick=function(){setTheme(theme,true);};toggle.appendChild(b);});
        header.appendChild(toggle);
        setTheme(document.documentElement.dataset.freeispTheme || (document.querySelector('link[href*="freeisp-night"]')?'night':'day'),false);
        window.addEventListener('storage',function(e){if(e.key==='freeisp-theme' && /^(day|night)$/.test(e.newValue)) setTheme(e.newValue,false);});
    }
});

/* Keep one LuCI runtime for ordinary sidebar navigation. Router HTML remains the
 * authority for route permissions/session; configuration is always read afresh. */
(function() {
 'use strict';
 if (!window.L || !L.view || !L.Poll || !document.getElementById('view')) return;
 let serial = 0, active = {id: 0, url: new URL(location.href), polls: [], pending: new Set(), listeners: [], work: Promise.resolve()}, controller, renderingOwner = null;
 const addPoll = L.Poll.add, removePoll = L.Poll.remove;
 const wrappers = new WeakMap();
 const initialRuntime = document.querySelector('script[src*="/luci.js"]')?.getAttribute('src');
 let releaseRevision = null, releaseChecked = 0, releaseRequest = null, reloadRequired = false;
 async function releaseChanged() {
  if (reloadRequired) return true;
  if (releaseRequest) return releaseRequest;
  if (Date.now() - releaseChecked < 30000) return false;
  releaseChecked = Date.now();
  releaseRequest = fetch('/luci-static/freeisp/release.json', {cache:'no-store', credentials:'omit', redirect:'error', signal:AbortSignal.timeout(4000)}).then(response => response.ok ? response.json() : null).then(value => {
   if (!value || !/^[a-f0-9]{40,64}$/.test(value.revision || '')) return false;
   const changed = releaseRevision !== null && releaseRevision !== value.revision;
   releaseRevision = value.revision; reloadRequired = reloadRequired || changed; return reloadRequired;
  }).catch(() => false).finally(() => { releaseRequest = null; });
  return releaseRequest;
 }
 releaseChanged();
 // Compatibility helpers from LuCI's admin_status/index template. The same
 // native overview widgets are retained when opening it without a new document.
 window.progressbar = window.progressbar || function(query, value, max, byte) {
  const node = document.querySelector(query), vn = parseInt(value) || 0, mn = parseInt(max) || 100;
  const fv = byte ? String.format('%1024.2mB', value) : value, fm = byte ? String.format('%1024.2mB', max) : max, percent = Math.floor(100 / mn * vn);
  if (node) { node.firstElementChild.style.width = percent + '%'; node.setAttribute('title', '%s / %s (%d%%)'.format(fv, fm, percent)); }
 };
 window.renderBox = window.renderBox || function(title, active, children) {
  children = children || []; children.unshift(L.itemlist(E('span'), [].slice.call(arguments, 3)));
  return E('div', {class:'ifacebox'}, [E('div', {class:'ifacebox-head center ' + (active ? 'active' : '')}, E('strong', title)), E('div', {class:'ifacebox-body left'}, children)]);
 };
 window.renderBadge = window.renderBadge || function(icon, title) {
  return E('span', {class:'ifacebadge'}, [E('img', {src:icon, title:title || ''}), L.itemlist(E('span'), [].slice.call(arguments, 2))]);
 };
 const loaded = () => L.loaded ? Promise.resolve() : new Promise(resolve => document.addEventListener('luci-loaded', resolve, {once:true}));
 const current = token => active === token && !token.cancelled && !token.expired;
 function watchEvents(target, eventName) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = function(name, fn, options) {
   if (name === eventName) {
    const owner = renderingOwner || active;
    if (owner.cancelled || owner.expired) return;
    owner.listeners.push([target, name, fn, options]);
   }
   return add(name, fn, options);
  };
 }
 watchEvents(window, 'beforeunload'); watchEvents(document, 'uci-applied');
 // A deferred chart script can finish after leaving its view. Its detached
 // element must not invoke callbacks against the next page's document.
 const addScriptEvent = HTMLScriptElement.prototype.addEventListener;
 HTMLScriptElement.prototype.addEventListener = function(name, fn, options) {
  if ((name === 'load' || name === 'error') && renderingOwner) {
   const owner = renderingOwner;
   if (owner.cancelled || owner.expired) return;
   owner.listeners.push([this, name, fn, options]);
  }
  return addScriptEvent.call(this, name, fn, options);
 };
 L.Poll.add = function(fn, interval) {
  if (typeof fn !== 'function') return addPoll.call(this, fn, interval);
  const owner = renderingOwner || active;
  if (owner.cancelled || owner.expired) return false;
  let record = wrappers.get(fn), wrapped = record && record.owner === owner ? record.wrapped : null;
  if (!wrapped) {
   wrapped = function() {
    if (!current(owner)) return Promise.resolve();
    const task = Promise.resolve().then(fn); owner.pending.add(task);
    return task.finally(() => owner.pending.delete(task));
   };
   wrappers.set(fn, {owner, wrapped}); owner.polls.push(wrapped);
  }
  return addPoll.call(this, wrapped, interval);
 };
 L.Poll.remove = function(fn) { return removePoll.call(this, wrappers.get(fn)?.wrapped || fn); };
 function dispose(token) {
  token.cancelled = true;
  token.polls.forEach(fn => removePoll.call(L.Poll, fn));
  token.listeners.forEach(([target, name, fn, options]) => target.removeEventListener(name, fn, options));
 }
 function render(instance, token) {
  instance.__freeispGeneration = token.id; renderingOwner = token;
  token.work = loaded().then(() => current(token) ? instance.load() : null).then(data => {
   if (current(token)) return instance.render(data);
  }).then(nodes => {
   if (!current(token)) return;
   const mount = document.getElementById('view');
   L.dom.content(mount, nodes); L.dom.append(mount, instance.addFooter());
   mount.dataset.freeispState = 'ready'; mount.removeAttribute('aria-busy');
   token.ready = true; L.Poll.start();
   document.dispatchEvent(new CustomEvent('freeisp-view-ready'));
  }).catch(error => { if (current(token)) fail(token, error); }).finally(() => {
   if (renderingOwner === token) renderingOwner = null;
   if (token.cancelled || token.expired) dispose(token);
  });
  instance.__freeispReady = token.work; return token.work;
 }
 L.view.prototype.__init__ = function() { return render(this, active); };
 function label(url) {
  const links = [...document.querySelectorAll('.freeisp-sidebar a')];
  const match = links.find(a => a.pathname === url.pathname) || (url.pathname.includes('/admin/wifi/') && links.find(a => a.pathname.endsWith('/wifi/interfaces')));
  return match ? match.textContent.trim() : 'Router settings';
 }
 function chrome(url) {
  document.querySelectorAll('.freeisp-sidebar a').forEach(a => {
   const selected = a.pathname === url.pathname || (a.pathname.endsWith('/wifi/interfaces') && url.pathname.includes('/admin/wifi/'));
   a.classList.toggle('active', selected);
   if (selected) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const brand = document.querySelector('header .brand'); if (brand) brand.textContent = 'Workspace / ' + label(url);
  document.querySelectorAll('.fi-wifi-navigation,.fi-wifi-note').forEach(node => node.remove());
  const tabs = document.getElementById('tabmenu'); if (tabs) { tabs.replaceChildren(); tabs.style.display = 'none'; }
 }
 function pending(token) {
  const mount = document.getElementById('view'); mount.dataset.freeispState = 'pending'; mount.setAttribute('aria-busy', 'true');
  const panel = document.createElement('section'); panel.className = 'cbi-section fi-page-pending';
  const title = document.createElement('h2'); title.textContent = label(token.url);
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = 'Getting current values from your router…';
  const hint = document.createElement('p'); hint.className = 'freeisp-note'; hint.textContent = 'You can keep using the menu. Settings become editable when their current values arrive.';
  panel.append(title, message, hint); mount.replaceChildren(panel);
 }
 function fail(token, error) {
  if (error) console.warn("FreeISP view:", error.message || String(error));
  const mount = document.getElementById('view'); mount.dataset.freeispState = 'error'; mount.removeAttribute('aria-busy');
  const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = 'Settings could not be read. Check the connection and try again.';
  const retry = document.createElement('button'); retry.className = 'cbi-button'; retry.textContent = 'Try again'; retry.onclick = () => navigate(token.url, true);
  mount.replaceChildren(Object.assign(document.createElement('h2'), {textContent:label(token.url)}), message, retry);
 }
 function environment(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const source = [...doc.scripts].map(s => s.textContent).find(s => /\bnew\s+LuCI\s*\(/.test(s));
  const match = source && source.match(/\bnew\s+LuCI\s*\(\s*(\{[\s\S]*\})\s*\)/);
  if (!match || doc.querySelector('input[name="luci_password"]')) return null;
  let env; try { env = JSON.parse(match[1]); } catch (_) { return null; }
  const action = env.nodespec?.action;
  // The stock Overview template contains this single view bootstrap.
  const viewPath = action?.type === 'view' ? action.path : action?.type === 'template' && action.path === 'admin_status/index' && [...doc.scripts].some(script => /ui\.instantiateView\(['"]status\/index['"]\)/.test(script.textContent)) ? 'status/index' : null;
  if (env.sessionid !== L.env.sessionid || env.scriptname !== L.env.scriptname || env.ubuspath !== L.env.ubuspath || !env.nodespec?.satisfied || !viewPath || !/^[a-zA-Z0-9_/-]+$/.test(viewPath)) return null;
  if (doc.querySelector('script[src*="/luci.js"]')?.getAttribute('src') !== initialRuntime) return null;
  return {env, path:viewPath, title:doc.title};
 }
 function canLeave() {
  const event = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(event);
  return !event.defaultPrevented || window.confirm('Discard unsaved changes and open another menu?');
 }
 async function navigate(url, replace) {
  if (!canLeave()) { if (replace && active.url) history.replaceState({freeisp:true}, '', active.url.href); return; }
  const previous = active; dispose(previous); if (controller) controller.abort(); controller = new AbortController();
  const token = active = {id:++serial, url, polls:[], pending:new Set(), listeners:[], work:Promise.resolve()};
  chrome(url); pending(token);
  const deadline = setTimeout(() => { if (current(token)) { controller.abort(); fail(token); token.expired = true; } }, 30000);
  try {
   // Start permission lookup while the old view finishes its already-started reads.
   const htmlTask = fetch(url.href, {credentials:'same-origin', cache:'no-store', redirect:'manual', signal:controller.signal}).then(async response => {
    if (!response.ok) return null; return environment(await response.text());
   });
   const results = await Promise.all([htmlTask, previous.work, Promise.allSettled([...previous.pending]), releaseChanged()]);
   if (!current(token)) return;
   const page = results[0]; if (!page || results[3]) { location.assign(url.href); return; }
   // Client-side UCI drafts are discarded only after the existing leave guard.
   const uci = await L.require('uci'); uci.unload(Object.keys(uci.loaded || {}));
   if (!current(token)) return;
   Object.assign(L.env, page.env); document.title = page.title;
   if (replace) history.replaceState({freeisp:true}, '', url.href); else history.pushState({freeisp:true}, '', url.href);
   if (L.network && /\/(wifi|network)\//.test(url.pathname) && !/freeisp_(pppoe|hotspot|tools)/.test(url.pathname)) await L.network.flushCache();
   if (!current(token)) return;
   const instance = await L.require('view.' + page.path.replace(/\//g, '.'));
   if (!current(token)) return;
   if (instance.__freeispGeneration !== token.id) new instance.constructor();
   await token.work;
   if (current(token) && url.pathname.includes('/admin/wifi/')) {
    const script = document.createElement('script'); script.src = '/luci-static/freeisp/wifi-navigation.js?v=1'; document.head.append(script);
   }
  } catch (error) { if (current(token)) fail(token, error); }
  finally { clearTimeout(deadline); }
 }
 document.addEventListener('click', event => {
  const anchor = event.target.closest?.('.freeisp-sidebar a,.fi-wifi-navigation a');
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.target || anchor.hasAttribute('download') || !L.loaded) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/cgi-bin/luci/admin/') || url.pathname.endsWith('/logout')) return;
  if (document.querySelector('.modal') && document.body.classList.contains('modal-overlay-active')) return;
  event.preventDefault(); navigate(url, false);
 });
 window.addEventListener('popstate', () => { if (L.loaded) navigate(new URL(location.href), true); });
 window.freeispNavigation = {navigate:href => navigate(new URL(href, location.href), false)};
})();
