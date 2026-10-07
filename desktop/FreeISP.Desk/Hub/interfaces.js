'use strict';
(() => {
 const $ = id => document.getElementById(id);
 const native = window.chrome && window.chrome.webview;
 const number = new Intl.NumberFormat(undefined, {maximumFractionDigits: 0});
 ['rx', 'tx'].forEach(kind => {
  const point = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  point.id = kind + '-point'; point.setAttribute('r', '3'); point.setAttribute('class', kind + '-point'); point.setAttribute('visibility', 'hidden'); $('traffic-chart').append(point);
 });
 let generation = null, devices = {}, rates = {}, history = {}, previous = null;
 let selected = null, sampleTime = null, receivedAt = null, received = false, connected = false;
 let inFlight = false, timer = null, disposed = false, hasRouter = false;

 function send(message) { if (native) native.postMessage(message); }
 function theme(value) {
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('freeisp-desk-theme', value); } catch (_) {}
  $('day').setAttribute('aria-pressed', String(value === 'day'));
  $('night').setAttribute('aria-pressed', String(value === 'night'));
 }
 let preference; try { preference = localStorage.getItem('freeisp-desk-theme'); } catch (_) {}
 theme(preference === 'night' ? 'night' : 'day');
 $('day').onclick = () => theme('day'); $('night').onclick = () => theme('night');
 $('logout').onclick = () => { if (hasRouter) send({action: 'disconnect'}); };
 $('current-interfaces').onclick = () => { $('search').focus(); };
 $('settings').onclick = () => { if (hasRouter) send({action: 'openRouterPage', route: 'network/freeisp_interfaces'}); };
 document.querySelectorAll('[data-route]').forEach(button => { button.onclick = () => { if (hasRouter) send({action: 'openRouterPage', route: button.dataset.route}); }; });
 $('search').oninput = drawTable;

 function cancelTimer() { clearTimeout(timer); timer = null; }
 function schedule(delay = 1000) {
  cancelTimer();
  if (!disposed && !document.hidden && hasRouter && generation !== null && !inFlight && native) timer = setTimeout(request, delay);
 }
 function request() {
  timer = null;
  if (disposed || document.hidden || !hasRouter || generation === null || inFlight || !native) return;
  inFlight = true; send({action: 'interfacesSnapshot', generation});
 }
 document.addEventListener('visibilitychange', () => { if (document.hidden) cancelTimer(); else schedule(0); });
 window.addEventListener('pagehide', () => { disposed = true; cancelTimer(); });

 function counter(value) {
  try {
   if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
   if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  } catch (_) {}
  return null;
 }
 function traffic(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']; let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return value.toLocaleString(undefined, {maximumFractionDigits: unit ? 1 : 0}) + ' ' + units[unit];
 }
 function packets(value) { const parsed = counter(value); return parsed === null ? '—' : number.format(parsed); }
 function rate(before, after, seconds) {
  before = counter(before); after = counter(after);
  if (before === null || after === null || after < before || seconds <= 0 || seconds > 5) return null;
  const value = Number(after - before) * 8 / seconds; return Number.isFinite(value) ? value : null;
 }
 function state(kind, title, detail) {
  $('connection-strip').dataset.state = kind;
  $('connection-status').textContent = title; $('connection-detail').textContent = detail;
 }
 function reset(context) {
  cancelTimer(); generation = context.generation; inFlight = false;
  devices = {}; rates = {}; history = {}; previous = null; selected = null;
  sampleTime = null; receivedAt = null; received = false; connected = false;
  hasRouter = typeof context.router === 'string' && context.router.trim().length > 0;
  $('router').textContent = hasRouter ? context.router : 'Choose a router to see its connections.'; $('settings').disabled = !hasRouter;
  document.querySelectorAll('[data-route]').forEach(button => { button.disabled = !hasRouter; });
  $('logout').disabled = !hasRouter;
  $('search').value = ''; $('sample-age').textContent = 'No data received';
  state('waiting', hasRouter ? 'Reading router data' : 'Choose a router', hasRouter ? 'Your interface workspace is ready. Waiting for the first reading.' : 'Open Device Hub to connect. This workspace is ready on your computer.');
  draw(); schedule(0);
 }
 function snapshot(sample) {
  if (!sample || !Number.isFinite(sample.sampleTime) || sample.sampleTime < 0 || !sample.devices || typeof sample.devices !== 'object' || Array.isArray(sample.devices)) { fail('The router returned an unreadable interface response.'); return; }
  if (sampleTime !== null && sample.sampleTime <= sampleTime) { fail('Waiting for a newer router reading.'); return; }
  const next = {};
  Object.keys(sample.devices).sort().forEach(name => { const d = sample.devices[name]; if (d && typeof d === 'object' && !Array.isArray(d)) Object.defineProperty(next, name, {value: d, enumerable: true}); });
  const seconds = previous ? (sample.sampleTime - previous.time) / 1000 : 0;
  const nextRates = {}, nextHistory = {};
  Object.keys(next).forEach(name => {
   const current = next[name].statistics || {}, before = previous && previous.devices[name] ? previous.devices[name].statistics || {} : {};
   const reading = {rx: rate(before.rx_bytes, current.rx_bytes, seconds), tx: rate(before.tx_bytes, current.tx_bytes, seconds)};
   Object.defineProperty(nextRates, name, {value: reading, enumerable: true});
   const points = Object.prototype.hasOwnProperty.call(history, name) ? history[name].slice() : [];
   points.push({time: sample.sampleTime, rx: reading.rx, tx: reading.tx});
   Object.defineProperty(nextHistory, name, {value: points.filter(p => p.time >= sample.sampleTime - 60000).slice(-90), enumerable: true});
  });
  devices = next; rates = nextRates; history = nextHistory;
  previous = {time: sample.sampleTime, devices}; sampleTime = sample.sampleTime; receivedAt = Date.now(); received = true; connected = true;
  if (!selected || !Object.prototype.hasOwnProperty.call(devices, selected)) selected = Object.keys(devices)[0] || null;
  state('live', 'Live connection', 'Interface values refresh about once a second.');
  $('sample-age').textContent = 'Received ' + new Date(receivedAt).toLocaleTimeString();
  draw(); schedule();
 }
 function fail(message) {
  connected = false; previous = null;
  state('error', received ? 'Disconnected · last received values' : 'Router data unavailable', String(message || 'The router could not be reached. Retrying while this page is open.').slice(0, 350));
  draw(); schedule();
 }
 function draw() {
  const names = Object.keys(devices), known = names.filter(n => typeof devices[n].up === 'boolean');
  $('interface-count').textContent = received ? String(names.length) : '—';
  $('up-count').textContent = received && (known.length || !names.length) ? String(known.filter(n => devices[n].up === true).length) : '—';
  $('up-note').textContent = !received ? 'Waiting for status' : !connected ? 'Last received status' : known.length < names.length ? (names.length - known.length) + ' status unknown' : 'Current interface status';
  $('rx-label').textContent = 'Receive · ' + (selected || 'selected interface'); $('tx-label').textContent = 'Transmit · ' + (selected || 'selected interface');
  const reading = selected && rates[selected]; $('rx-rate').textContent = traffic(reading && reading.rx); $('tx-rate').textContent = traffic(reading && reading.tx);
  $('table-note').textContent = !received ? 'Live values update about once a second.' : connected ? 'Live · ' + names.length + ' interface' + (names.length === 1 ? '' : 's') : 'Disconnected · values below are from the last successful reading';
  drawTable(); drawChart();
 }
 function textCell(text) { const cell = document.createElement('td'); cell.textContent = text; return cell; }
 function drawTable() {
  const body = $('interface-rows'), query = $('search').value.toLocaleLowerCase();
  const focusName = document.activeElement && document.activeElement.dataset.interface;
  const names = Object.keys(devices).filter(name => name.toLocaleLowerCase().includes(query));
  body.replaceChildren();
  if (!names.length) {
   const row = document.createElement('tr'), cell = textCell(!received ? 'Waiting for router data. No connection status has been assumed.' : query ? 'No interfaces match your search.' : 'The router reported no interfaces.');
   cell.colSpan = 8; cell.className = 'table-empty'; row.append(cell); body.append(row); return;
  }
  names.forEach(name => {
   const d = devices[name], stats = d.statistics || {}, reading = rates[name] || {}, row = document.createElement('tr');
   row.classList.toggle('selected', name === selected);
   const cell = document.createElement('td'), button = document.createElement('button');
   button.type = 'button'; button.className = 'interface-select'; button.dataset.interface = name; button.textContent = name;
   button.setAttribute('aria-pressed', String(name === selected)); button.setAttribute('aria-label', 'Show traffic for ' + name);
   button.onclick = () => { selected = name; draw(); }; cell.append(button); row.append(cell);
   const badgeCell = document.createElement('td'), badge = document.createElement('span');
   const known = typeof d.up === 'boolean'; badge.className = 'state-badge ' + (!connected ? 'stale' : known ? d.up ? 'up' : 'down' : 'unknown');
   badge.textContent = (known ? d.up ? 'Up' : 'Down' : 'Unknown') + (!connected ? ' · last' : ''); badgeCell.append(badge); row.append(badgeCell);
   const mtu = counter(d.mtu);
   row.append(textCell(typeof d.type === 'string' && d.type ? d.type : 'Unknown'), textCell(mtu === null ? '—' : number.format(mtu)), textCell(traffic(reading.rx)), textCell(traffic(reading.tx)), textCell(packets(stats.rx_packets)), textCell(packets(stats.tx_packets)));
   body.append(row);
   if (focusName === name) button.focus({preventScroll: true});
  });
 }
 function drawChart() {
  const points = selected && history[selected] || [], valid = points.filter(p => p.rx !== null || p.tx !== null);
  $('traffic-title').textContent = selected || 'Select an interface';
  $('chart-placeholder').hidden = valid.length > 0;
  $('chart-placeholder').textContent = !connected && received ? 'Connection lost. Waiting for fresh readings.' : 'Traffic rates appear after two readings.';
  $('chart-state').textContent = !received ? 'Waiting for readings' : !connected ? 'Disconnected · last readings' : valid.length ? 'Live · bits per second' : 'Measuring traffic';
  const maximum = Math.max(1, ...valid.map(p => Math.max(p.rx || 0, p.tx || 0)));
  $('chart-scale').textContent = valid.length ? traffic(maximum) : '—';
  ['rx', 'tx'].forEach(kind => {
   let path = '', start = true;
   points.forEach(p => { if (p[kind] === null) { start = true; return; } const x = 800 * Math.max(0, 1 - (sampleTime - p.time) / 60000), y = 145 - p[kind] / maximum * 135; path += (start ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '; start = false; });
   $(kind + '-path').setAttribute('d', path);
   const latest = points[points.length - 1], point = $(kind + '-point');
   point.setAttribute('visibility', latest && latest[kind] !== null ? 'visible' : 'hidden');
   if (latest && latest[kind] !== null) { point.setAttribute('cx', '800'); point.setAttribute('cy', String(145 - latest[kind] / maximum * 135)); }
  });
  $('traffic-chart').setAttribute('aria-label', selected ? (connected ? 'Live' : 'Last received') + ' receive and transmit traffic for ' + selected + '. Receive ' + $('rx-rate').textContent + ', transmit ' + $('tx-rate').textContent + '.' : 'Traffic history is waiting for an interface');
 }
 if (native) native.addEventListener('message', event => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'interfaceContext' && Number.isInteger(m.generation)) { if (generation === null || m.generation >= generation) reset(m); return; }
  if (!hasRouter || generation === null || m.generation !== generation) return;
  if (m.type === 'interfaceSnapshot') { inFlight = false; snapshot(m.sample); }
  if (m.type === 'interfaceError') { inFlight = false; fail(m.message); }
 });
 else state('waiting', 'Local workspace preview', 'Open FreeISP Desk and connect a router to see live interface values.');
 draw();
})();
