'use strict';
/* RemoteTV phone client. Talks to the hub over REST + a WebSocket for live state. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DEFAULT_SHORTCUTS = 'Netflix, YouTube, Prime Video, Disney+, Spotify';
const APP_COLORS = {
  netflix: ['#e50914', 'N'], youtube: ['#ff0000', '▶'], 'prime video': ['#1a98ff', 'p'], prime: ['#1a98ff', 'p'],
  'disney+': ['#0b2a7a', 'D+'], spotify: ['#1db954', '♪'], 'google tv': ['#4285f4', 'G'], 'apple tv': ['#222', ''],
  twitch: ['#9146ff', 'T'], hbo: ['#5b2be0', 'H'], max: ['#002be7', 'M'], iqiyi: ['#00be06', 'i'], viu: ['#f5b800', 'V'],
  tonton: ['#ff2c55', 't'], 'astro go': ['#e4007c', 'A'], plex: ['#e5a00d', '›'], kodi: ['#17b2e7', 'K'],
};

const settings = Object.assign({
  nav: 'touchpad', haptic: true, smooth: true, awake: true, theater: false, sens: 40, shortcuts: DEFAULT_SHORTCUTS,
}, safeJson(localStorage.getItem('remotetv.settings')));

const state = { devices: [], current: null, info: null, pin: localStorage.getItem('remotetv.pin') || '', muted: false };

function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { try { localStorage.setItem('remotetv.settings', JSON.stringify(settings)); } catch { /* private mode */ } }

// ------------------------------------------------------------------ api
// In the Android app (Capacitor) the backend runs inside the app itself;
// in a normal browser it is the Node hub at /api.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();

async function api(path, opts = {}) {
  if (window.NativeBackend) {
    try { return await window.NativeBackend.request(opts.method || (opts.body ? 'POST' : 'GET'), path, opts.body); }
    catch (e) { throw new Error(e.message); }
  }
  const headers = { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers };
  if (state.pin) headers['x-pin'] = state.pin;
  const res = await fetch(`/api${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body instanceof Blob ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    state.pin = prompt('Hub PIN') || '';
    localStorage.setItem('remotetv.pin', state.pin);
    return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const dev = () => state.current;
const devApi = (p, body) => api(`/devices/${dev().id}${p}`, body !== undefined ? { body } : {});

// ---------------------------------------------------------------- ui bits
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4000 : 1800);
}
function buzz(ms = 12) { if (settings.haptic && navigator.vibrate) navigator.vibrate(ms); }

function openSheet(html, onMount) {
  $('#sheetBody').innerHTML = html;
  $('#scrim').classList.remove('hidden');
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
  onMount?.($('#sheetBody'));
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#scrim').classList.add('hidden');
}
$('#scrim').addEventListener('click', closeSheet);

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// --------------------------------------------------------------- devices
function setStatus(kind, label) {
  $('#statusDot').className = `dot ${kind}`;
  if (label) $('#deviceName').textContent = label;
}

async function loadDevices() {
  state.devices = await api('/devices');
  renderDeviceList();
}

async function selectDevice(d) {
  state.current = d;
  setStatus('busy', d.name);
  try {
    const r = await api(`/devices/${d.id}/connect`, { body: {} });
    if (r.status === 'pairing') return; // the websocket 'pairing' event opens the code sheet
    setStatus('on', d.name);
    applyState(r.state);
    loadShortcuts();
  } catch (e) {
    setStatus('err', d.name);
    toast(e.message, true);
  }
}

function deviceSheet() {
  const items = state.devices.map((d) => `
    <button class="item" data-pick="${d.id}" style="width:100%;text-align:left">
      <div><b>${esc(d.name)}<span class="tag">${esc(d.type)}</span></b><small>${esc(d.host)} · ${esc(d.status)}</small></div>
      <span class="dot ${d.status === 'connected' ? 'on' : ''}"></span>
    </button>`).join('');
  openSheet(`<h2>Your TVs</h2>
    <div class="card list">${items || '<div class="item"><small>No TV saved yet. Scan your Wi-Fi network.</small></div>'}</div>
    <div class="row gap"><button class="btn" id="sScan">Scan network</button><button class="btn ghost" id="sManual">Add by IP</button></div>
    ${state.info?.hasIr ? `<div class="row gap" style="margin-top:8px"><button class="btn ghost" id="sIr">Sony TV · infra-red (no Wi-Fi)</button></div>
    <p class="sub" style="margin-top:6px">Infra-red works like the original remote: point the top of the phone at the TV. Buttons only — no volume level, apps list or keyboard.</p>` : ''}
    <div id="scanOut"></div>`, (el) => {
    if ($('#sIr', el)) $('#sIr', el).onclick = () => addDevice({ type: 'sony_ir', name: 'Sony TV (infra-red)' });
    $$('[data-pick]', el).forEach((b) => b.onclick = () => { closeSheet(); selectDevice(state.devices.find((d) => d.id === b.dataset.pick)); });
    $('#sScan', el).onclick = () => scan($('#scanOut', el));
    $('#sManual', el).onclick = manualAdd;
  });
}

const NATIVE_TYPES = ['sony', 'androidtv', 'roku'];
const TYPE_LABEL = { sony: 'Sony BRAVIA (IP control)', androidtv: 'Android / Google TV', roku: 'Roku', lg: 'LG webOS', samsung: 'Samsung Tizen' };

async function scan(out) {
  out.innerHTML = '<p class="sub">Scanning Wi-Fi for TVs…</p>';
  try {
    const found = await api('/discover?timeout=3500');
    if (!found.length) { out.innerHTML = '<p class="sub">No TV found. Make sure the TV is on and on the same Wi-Fi, or add it by IP.</p>'; return; }
    out.innerHTML = `<h3>Found</h3><div class="card list">${found.map((f, i) => `
      <div class="item"><div><b>${esc(f.name || f.host)}</b><small>${esc(f.modelName || '')} ${esc(f.host)}${f.dlna ? ' · cast ready' : ''}</small></div>
      <div class="dev-actions">${f.protocols.map((p) => `<button class="btn small" data-add="${i}" data-type="${p}">${esc(TYPE_LABEL[p] || p)}</button>`).join('')}</div></div>`).join('')}</div>
      <p class="sub" style="margin-top:8px">Sony Android TVs show two options: "Android TV" pairs with an on-screen code; "Sony BRAVIA" needs IP control + PSK and adds keyboard, input list and exact volume.</p>`;
    $$('[data-add]', out).forEach((b) => b.onclick = () => addDevice({ ...found[b.dataset.add], type: b.dataset.type }));
  } catch (e) { out.innerHTML = `<p class="sub">Scan failed: ${esc(e.message)}</p>`; }
}

async function addDevice(f) {
  const body = { host: f.host, type: f.type, name: f.name || f.modelName || f.host, dlna: f.dlna, dialUrl: f.dialUrl, port: f.port };
  if (f.type === 'sony') {
    const psk = prompt('Sony Pre-Shared Key\n(TV: Settings › Network › Home network › IP control › Pre-Shared Key)', '0000');
    if (psk === null) return;
    body.psk = psk;
  }
  try {
    const d = await api('/devices', { body });
    await loadDevices();
    closeSheet();
    selectDevice(state.devices.find((x) => x.id === d.id));
  } catch (e) { toast(e.message, true); }
}

function manualAdd() {
  openSheet(`<h2>Add TV by IP</h2>
    <div class="card">
      <label class="field">TV IP address<div class="row"><input id="mHost" placeholder="192.168.1.50" inputmode="decimal"></div></label>
      <label class="field">Brand / protocol<div class="row"><select id="mType">${Object.entries(TYPE_LABEL).filter(([k]) => !NATIVE || NATIVE_TYPES.includes(k)).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div></label>
      <label class="field">Name<div class="row"><input id="mName" placeholder="Living room TV"></div></label>
    </div><div class="row gap"><button class="btn" id="mSave">Save & connect</button></div>`, (el) => {
    $('#mSave', el).onclick = () => {
      const host = $('#mHost', el).value.trim();
      if (!/^[\w.-]+$/.test(host)) return toast('Enter a valid IP address', true);
      addDevice({ host, type: $('#mType', el).value, name: $('#mName', el).value.trim() || host });
    };
  });
}

function pairingSheet(msg) {
  if (msg.noCode) { toast(msg.message); setStatus('busy', 'Check your TV…'); return; }
  openSheet(`<h2>Pair with your TV</h2><p class="sub">${esc(msg.message)}</p>
    <div class="row gap"><input id="pCode" maxlength="8" autocomplete="one-time-code" style="text-transform:uppercase;font-size:22px;letter-spacing:.3em;text-align:center"><button class="btn" id="pGo">Pair</button></div>`, (el) => {
    const input = $('#pCode', el);
    setTimeout(() => input.focus(), 250);
    const go = async () => {
      try { await devApi('/pair', { code: input.value }); closeSheet(); toast('Paired ✓'); if (!NATIVE) setTimeout(() => selectDevice(dev()), 1500); }
      catch (e) { toast(e.message, true); }
    };
    $('#pGo', el).onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

// --------------------------------------------------------------- keys
async function sendKey(key, mode) {
  if (!dev()) { deviceSheet(); return; }
  buzz();
  try { await devApi('/key', { key, mode }); }
  catch (e) { toast(e.message, true); if (/reach|Timeout/.test(e.message)) setStatus('err'); }
}

// Buttons with data-key; data-repeat buttons auto-repeat while held.
$$('[data-key]').forEach((b) => {
  const key = b.dataset.key;
  if (!b.hasAttribute('data-repeat')) { b.addEventListener('click', () => sendKey(key)); return; }
  let t1, t2;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sendKey(key);
    t1 = setTimeout(() => { t2 = setInterval(() => sendKey(key), 140); }, 420);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});

// ---------------------------------------------------------- touchpad
(function touchpad() {
  const pad = $('#touchpad');
  const ripple = $('#ripple');
  let sx, sy, moved, holdT;
  const arrows = { up: '↑', down: '↓', left: '←', right: '→' };
  const showArrow = (dir) => {
    const a = document.createElement('span');
    a.className = 'arrow go';
    a.textContent = arrows[dir];
    const pos = { up: 'top:12px', down: 'bottom:12px', left: 'left:16px', right: 'right:16px' }[dir];
    a.style.cssText = pos;
    pad.appendChild(a);
    setTimeout(() => a.remove(), 400);
  };
  const fire = (dir) => { sendKey(dir); showArrow(dir); };

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY; moved = false;
    holdT = setTimeout(() => { if (!moved) { moved = true; sendKey('back'); toast('Back'); } }, 650);
  });
  pad.addEventListener('pointermove', (e) => {
    if (sx === undefined) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const th = 100 - settings.sens; // higher sensitivity = shorter swipe
    if (Math.abs(dx) < th && Math.abs(dy) < th) return;
    clearTimeout(holdT);
    moved = true;
    fire(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    sx = e.clientX; sy = e.clientY; // keep swiping = more steps
  });
  const end = (e) => {
    clearTimeout(holdT);
    if (sx !== undefined && !moved) {
      const r = pad.getBoundingClientRect();
      ripple.style.left = `${e.clientX - r.left}px`; ripple.style.top = `${e.clientY - r.top}px`;
      ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go');
      sendKey('ok');
    }
    sx = undefined;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', () => { clearTimeout(holdT); sx = undefined; });
})();

function applyNav() {
  $('#touchpad').classList.toggle('hidden', settings.nav !== 'touchpad');
  $('#dpad').classList.toggle('hidden', settings.nav !== 'dpad');
  $('#setNav').value = settings.nav;
}
$('#modeSwap').onclick = () => { settings.nav = settings.nav === 'touchpad' ? 'dpad' : 'touchpad'; saveSettings(); applyNav(); };

// ------------------------------------------------------------- live state
function applyState(s = {}) {
  if (s.volume !== undefined) {
    $('#volLevel').textContent = s.muted ? '✕' : s.volume;
    $('#volFill').style.height = `${Math.min(100, (s.volume / (s.volumeMax || 100)) * 100)}%`;
  }
  if (s.muted !== undefined) $('#btnMute').classList.toggle('muted-on', !!s.muted);
  if (s.power === false) setStatus('', `${dev()?.name || 'TV'} · standby`);
  else if (s.power === true && dev()) setStatus('on', dev().name);
}

function handleEvent(m) {
  if (!dev() || m.deviceId !== dev().id) return;
  if (m.type === 'state') applyState(m.payload);
  if (m.type === 'pairing') pairingSheet(m.payload);
  if (m.type === 'paired') { setStatus('on', dev().name); toast('Connected ✓'); }
  if (m.type === 'error') toast(m.payload, true);
}

function connectWs() {
  if (window.NativeBackend) { window.NativeBackend.onEvent(handleEvent); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws${state.pin ? `?pin=${encodeURIComponent(state.pin)}` : ''}`);
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connectWs, 2000);
}

// -------------------------------------------------------------- shortcuts
function appTile(name, icon) {
  const [c, letter] = APP_COLORS[name.toLowerCase()] || [`hsl(${[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360} 55% 42%)`, name[0]?.toUpperCase()];
  const art = icon ? `<img src="${esc(icon)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{textContent:'${esc(letter)}'}))">` : `<i style="--c:${c}">${esc(letter)}</i>`;
  return `${art}<span>${esc(name)}</span>`;
}

function loadShortcuts() {
  const names = settings.shortcuts.split(',').map((s) => s.trim()).filter(Boolean);
  $('#shortcuts').innerHTML = names.map((n) => `<button class="app" data-app="${esc(n)}">${appTile(n)}</button>`).join('');
  $$('#shortcuts [data-app]').forEach((b) => b.onclick = () => launch(b.dataset.app));
}

async function launch(id, name) {
  if (!dev()) return deviceSheet();
  buzz();
  try { await devApi('/launch', { id }); toast(`Opening ${name || id}`); }
  catch (e) { toast(e.message, true); }
}

$('#btnApps').onclick = async () => {
  if (!dev()) return deviceSheet();
  openSheet('<h2>Apps</h2><p class="sub">Loading apps from your TV…</p>');
  try {
    const apps = await devApi('/apps');
    let inputs = [];
    try { inputs = await devApi('/inputs'); } catch { /* not all TVs */ }
    $('#sheetBody').innerHTML = `<h2>Apps</h2><div class="applist">${apps.map((a, i) => `<button class="app" data-i="${i}">${appTile(a.name, a.icon)}</button>`).join('') || '<p class="sub">This TV does not list apps.</p>'}</div>
      ${inputs.length ? `<h3>Inputs</h3><div class="card list">${inputs.map((x, i) => `<button class="item" data-in="${i}" style="width:100%;text-align:left"><div><b>${esc(x.name)}</b></div></button>`).join('')}</div>` : ''}
      <div class="row gap"><button class="btn ghost" id="aMenu">TV menu key</button><button class="btn ghost" id="aSettings">Settings key</button></div>`;
    $$('[data-i]').forEach((b) => b.onclick = () => { closeSheet(); launch(apps[b.dataset.i].id, apps[b.dataset.i].name); });
    $$('[data-in]').forEach((b) => b.onclick = async () => { closeSheet(); try { await devApi('/input', { id: inputs[b.dataset.in].id }); } catch (e) { toast(e.message, true); } });
    $('#aMenu').onclick = () => sendKey('menu');
    $('#aSettings').onclick = () => sendKey('settings');
  } catch (e) { $('#sheetBody').innerHTML = `<h2>Apps</h2><p class="sub">${esc(e.message)}</p>`; }
};

// ------------------------------------------------------- keyboard / voice
function keyboardSheet(prefill = '') {
  openSheet(`<h2>Type on TV</h2><p class="sub">Focus a search box on the TV, then send text.</p>
    <div class="row gap"><input id="kText" value="${esc(prefill)}" placeholder="Search…" autocomplete="off"><button class="btn" id="kSend">Send</button></div>
    <div class="row gap"><button class="btn ghost" id="kOk">Enter / OK</button><button class="btn ghost" id="kBack">Back</button></div>`, (el) => {
    const input = $('#kText', el);
    setTimeout(() => input.focus(), 250);
    const send = async () => {
      if (!input.value) return;
      try { await devApi('/text', { text: input.value }); toast('Sent'); input.value = ''; }
      catch (e) { toast(e.message, true); }
    };
    $('#kSend', el).onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
    $('#kOk', el).onclick = () => sendKey('ok');
    $('#kBack', el).onclick = () => sendKey('back');
  });
}
$('#btnKeyboard').onclick = () => (dev() ? keyboardSheet() : deviceSheet());

$('#btnVoice').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast(window.isSecureContext ? 'Voice not supported in this browser' : 'Voice needs the HTTPS address (see Settings)', true); return; }
  if (!dev()) return deviceSheet();
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  const btn = $('#btnVoice');
  btn.classList.add('listening');
  buzz(30);
  rec.onresult = async (e) => {
    const text = e.results[0][0].transcript;
    toast(`“${text}”`);
    // Open the TV search, then type what was said.
    try { await devApi('/key', { key: 'search' }); } catch { /* not all TVs */ }
    setTimeout(() => devApi('/text', { text }).catch(() => keyboardSheet(text)), 1200);
  };
  rec.onerror = (e) => toast(`Voice: ${e.error}`, true);
  rec.onend = () => btn.classList.remove('listening');
  rec.start();
};

$('#btnNumpad').onclick = () => {
  openSheet(`<h2>Numbers</h2><div class="numpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join('')}
    <button data-n="info" style="font-size:14px">INFO</button><button data-n="0">0</button><button data-n="guide" style="font-size:14px">GUIDE</button></div>
    <div class="colors"><button data-n="red" style="background:#e11d48"></button><button data-n="green" style="background:#16a34a"></button><button data-n="yellow" style="background:#eab308"></button><button data-n="blue" style="background:#2563eb"></button></div>`, (el) => {
    $$('[data-n]', el).forEach((b) => b.onclick = () => sendKey(b.dataset.n));
  });
};

$('#devicePill').onclick = async () => { await loadDevices().catch(() => {}); deviceSheet(); };

// ------------------------------------------------------------------ cast
let castPoll;
function castStarted(title) {
  $('#nowPlaying').classList.remove('hidden');
  $('#npTitle').textContent = title;
  clearInterval(castPoll);
  castPoll = setInterval(async () => {
    try {
      const s = await devApi('/cast/status');
      $('#npTime').textContent = `${s.state || ''} ${s.position || ''} / ${s.duration || ''}`;
      if (s.state === 'STOPPED' || s.state === 'NO_MEDIA_PRESENT') { clearInterval(castPoll); }
    } catch { clearInterval(castPoll); }
  }, 2000);
}

// In the app, the system file picker is used and the phone serves the file to the TV.
$$('.tile').forEach((tile) => tile.addEventListener('click', async (e) => {
  if (!NATIVE) return; // browser: the hidden <input type=file> handles it
  e.preventDefault();
  if (!dev()) return deviceSheet();
  const mime = $('input', tile).accept;
  try {
    const r = await devApi('/cast/pick', { mime });
    toast('Playing on TV');
    castStarted(r.name);
  } catch (err) { if (!/cancel/i.test(err.message)) toast(err.message, true); }
}));

$$('[data-upload]').forEach((input) => input.addEventListener('change', () => {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!dev()) return deviceSheet();
  const bar = $('#uploadBar');
  bar.classList.remove('hidden');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/devices/${dev().id}/cast/upload`);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
  if (state.pin) xhr.setRequestHeader('x-pin', state.pin);
  xhr.upload.onprogress = (e) => { $('div', bar).style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    bar.classList.add('hidden');
    $('div', bar).style.width = '0';
    if (xhr.status === 200) { toast('Playing on TV'); castStarted(file.name); }
    else toast(safeJson(xhr.responseText).error || `Cast failed (${xhr.status})`, true);
  };
  xhr.onerror = () => { bar.classList.add('hidden'); toast('Upload failed', true); };
  xhr.send(file);
}));

$('#btnYt').onclick = async () => {
  if (!dev()) return deviceSheet();
  try { await devApi('/cast/youtube', { url: $('#ytUrl').value }); toast('Opening on YouTube'); }
  catch (e) { toast(e.message, true); }
};
$('#btnWeb').onclick = async () => {
  if (!dev()) return deviceSheet();
  const url = $('#webUrl').value.trim();
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mkv: 'video/x-matroska', webm: 'video/webm', m3u8: 'application/vnd.apple.mpegurl' }[ext] || 'video/mp4';
  try { await devApi('/cast/url', { url, mime }); toast('Playing on TV'); castStarted(url.split('/').pop()); }
  catch (e) { toast(e.message, true); }
};
$$('[data-cast]').forEach((b) => b.onclick = async () => {
  try { await devApi('/cast/control', { action: b.dataset.cast }); if (b.dataset.cast === 'stop') $('#nowPlaying').classList.add('hidden'); }
  catch (e) { toast(e.message, true); }
});

// --------------------------------------------------------------- settings
function renderDeviceList() {
  const el = $('#deviceList');
  el.innerHTML = state.devices.map((d) => `
    <div class="item"><div><b>${esc(d.name)}<span class="tag">${esc(d.type)}</span></b><small>${esc(d.host)}${d.mac ? ` · ${esc(d.mac)}` : ''}${d.dlna ? ' · cast ready' : ''}</small></div>
      <div class="dev-actions">
        <button class="btn small ghost" data-edit="${d.id}">Edit</button>
        <button class="btn small danger" data-del="${d.id}">Forget</button>
      </div></div>`).join('') || '<div class="item"><small>No TVs saved yet.</small></div>';
  $$('[data-del]', el).forEach((b) => b.onclick = async () => {
    if (!confirm('Forget this TV? Its pairing will be removed.')) return;
    await api(`/devices/${b.dataset.del}`, { method: 'DELETE' });
    if (dev()?.id === b.dataset.del) { state.current = null; setStatus('', 'Tap to connect your TV'); }
    loadDevices();
  });
  $$('[data-edit]', el).forEach((b) => b.onclick = () => editDevice(state.devices.find((d) => d.id === b.dataset.edit)));
}

function editDevice(d) {
  openSheet(`<h2>Edit ${esc(d.name)}</h2><div class="card">
    <label class="field">Name<div class="row"><input id="eName" value="${esc(d.name)}"></div></label>
    ${d.type === 'sony' ? '<label class="field">Pre-Shared Key (leave blank to keep)<div class="row"><input id="ePsk" type="password"></div></label>' : ''}
    <label class="field">MAC address (for Wake-on-LAN power on)<div class="row"><input id="eMac" value="${esc(d.mac || '')}" placeholder="AA:BB:CC:DD:EE:FF"></div></label>
  </div><div class="row gap"><button class="btn" id="eSave">Save</button><button class="btn ghost" id="eWake">Wake TV now</button></div>`, (el) => {
    $('#eSave', el).onclick = async () => {
      const body = { name: $('#eName', el).value.trim() || d.name, mac: $('#eMac', el).value.trim() };
      const psk = $('#ePsk', el)?.value;
      if (psk) body.psk = psk;
      try { await api(`/devices/${d.id}`, { method: 'PATCH', body }); toast('Saved'); closeSheet(); loadDevices(); }
      catch (e) { toast(e.message, true); }
    };
    $('#eWake', el).onclick = async () => {
      try { await api(`/devices/${d.id}/wake`, { body: {} }); toast('Wake packet sent'); } catch (e) { toast(e.message, true); }
    };
  });
}

$('#btnScan').onclick = () => { deviceSheet(); setTimeout(() => $('#sScan')?.click(), 50); };
$('#btnAddManual').onclick = manualAdd;

let wakeLock;
async function applyAwake() {
  try {
    if (window.NativeBackend) { await window.NativeBackend.keepAwake(!!settings.awake); return; }
    if (settings.awake && 'wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* needs https */ }
}
document.addEventListener('visibilitychange', applyAwake);

function applySettings() {
  document.body.classList.toggle('smooth', settings.smooth);
  $('#theaterDim').classList.toggle('hidden', !settings.theater);
  $('#setHaptic').checked = settings.haptic;
  $('#setSmooth').checked = settings.smooth;
  $('#setAwake').checked = settings.awake;
  $('#setTheater').checked = settings.theater;
  $('#setSens').value = settings.sens;
  $('#sensLabel').textContent = settings.sens > 60 ? 'High' : settings.sens < 35 ? 'Low' : 'Normal';
  $('#setShortcuts').value = settings.shortcuts;
  applyNav();
  applyAwake();
}

const bind = (id, key, fn) => $(id).addEventListener('change', (e) => {
  settings[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? Number(e.target.value) : e.target.value;
  saveSettings(); applySettings(); fn?.();
});
bind('#setHaptic', 'haptic');
bind('#setSmooth', 'smooth');
bind('#setAwake', 'awake');
bind('#setTheater', 'theater', () => {
  if (settings.theater) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen();
});
bind('#setSens', 'sens');
bind('#setNav', 'nav');
bind('#setShortcuts', 'shortcuts', loadShortcuts);

// ------------------------------------------------------------------ tabs
$$('.tab').forEach((t) => t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
});

// ------------------------------------------------------ desktop keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Backspace: 'back', Escape: 'back', h: 'home', '+': 'vol_up', '=': 'vol_up', '-': 'vol_down', m: 'mute', ' ': 'play_pause', PageUp: 'ch_up', PageDown: 'ch_down' };
  const k = map[e.key] || (/^[0-9]$/.test(e.key) ? e.key : null);
  if (!k) return;
  e.preventDefault();
  sendKey(k);
});

// ------------------------------------------------------------------ boot
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`Cannot load ${src}`));
    document.head.appendChild(el);
  });
}

(async function boot() {
  if (NATIVE) {
    for (const src of ['vendor/forge.min.js', 'vendor/protobuf.min.js', 'vendor/protos.js', 'native/drivers.js', 'native/backend.js']) await loadScript(src);
    document.body.classList.add('native');
  }
  applySettings();
  loadShortcuts();
  connectWs();
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    state.info = await api('/info');
    $('#hubAddr').textContent = NATIVE ? 'Running on this phone — no PC needed' : `${state.info.hub}  ·  HTTPS :8443 for voice`;
    await loadDevices();
    const last = state.devices.find((d) => d.id === state.info.lastDeviceId) || state.devices[0];
    if (last) selectDevice(last);
  } catch (e) { toast(`Hub unreachable: ${e.message}`, true); }
})();
