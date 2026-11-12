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
  nav: 'touchpad', simple: false, haptic: true, smooth: true, awake: true, theater: false, sens: 40, shortcuts: DEFAULT_SHORTCUTS,
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
  airCleanup?.();
  stopScreen();
  $('#sheetBody').innerHTML = html;
  $('#scrim').classList.remove('hidden');
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
  onMount?.($('#sheetBody'));
}
function closeSheet() {
  airCleanup?.();
  stopScreen();
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
  state.currentApp = null;
  renderStrip();
  setStatus('busy', d.name);
  try {
    const r = await api(`/devices/${d.id}/connect`, { body: {} });
    if (r.status === 'pairing') return; // the websocket 'pairing' event opens the code sheet
    setStatus('on', d.name);
    applyState(r.state);
    loadShortcuts();
    if (pendingShare) { const u = pendingShare; pendingShare = null; openOnTv(u); }
  } catch (e) {
    setStatus('err', d.name);
    toast(e.message, true);
  }
}

const tempLeft = (d) => (d.expiresAt ? `shop TV · forgotten in ${Math.max(1, Math.ceil((d.expiresAt - Date.now()) / 86400000))} days if unused` : '');
const hostLabel = (d) => (/^infra-red/.test(d.host || '') ? 'infra-red' : d.host);
let tempAdd = false; // "shop TV" switch in the TV sheet

function deviceSheet() {
  const items = state.devices.map((d) => `
    <button class="item" data-pick="${d.id}" style="width:100%;text-align:left">
      <div><b>${esc(d.name)}<span class="tag">${esc(d.temp ? 'shop' : d.type)}</span></b><small>${esc(hostLabel(d))} · ${esc(d.status)}${d.temp ? ` · ${esc(tempLeft(d))}` : ''}</small></div>
      <span class="dot ${d.status === 'connected' ? 'on' : ''}"></span>
    </button>`).join('');
  openSheet(`<h2>Your TVs</h2>
    <div class="card list">${items || '<div class="item"><small>No TV saved yet. Scan your Wi-Fi network.</small></div>'}</div>
    <label class="item card shop-switch"><div><b>Shop / someone else's TV</b><small>Forgotten automatically after 1 month without use</small></div><input type="checkbox" class="switch" id="sTemp" ${tempAdd ? 'checked' : ''}></label>
    <div class="row gap"><button class="btn" id="sScan">Scan network</button><button class="btn ghost" id="sManual">Add by IP</button></div>
    ${state.info?.hasIr ? `<h3>Infra-red (no Wi-Fi needed)</h3>
    <p class="sub">Point the top of the phone at the TV. Best for a shop or clinic TV: no Wi-Fi or pairing. Pick the brand written on the TV.</p>
    <div class="choices">${(state.irBrands || []).map((b) => `<button class="btn ghost" data-ir="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div>
    <div class="row gap"><button class="btn" id="sFind">Not sure? Find my TV</button></div>` : ''}
    <div id="scanOut"></div>`, (el) => {
    $('#sTemp', el).onchange = (e) => { tempAdd = e.target.checked; };
    $$('[data-ir]', el).forEach((b) => b.onclick = () => addDevice({ type: 'ir', brand: b.dataset.ir }));
    if ($('#sFind', el)) $('#sFind', el).onclick = () => findMyTv(0);
    $$('[data-pick]', el).forEach((b) => b.onclick = () => { closeSheet(); selectDevice(state.devices.find((d) => d.id === b.dataset.pick)); });
    $('#sScan', el).onclick = () => scan($('#scanOut', el));
    $('#sManual', el).onclick = manualAdd;
  });
}

// "Find my TV": tries each infra-red code set with Volume + until the user sees the TV react.
async function findMyTv(i) {
  const brands = state.irBrands || [];
  if (i >= brands.length) {
    openSheet(`<h2>Find my TV</h2><p class="sub">None of the ${brands.length} code sets worked. Check that you point the top of the phone at the TV from 1–3 metres, then try again. This TV brand may not be supported yet — tell us the brand on GitHub.</p>
      <div class="row gap"><button class="btn" id="fAgain">Start again</button></div>`, (el) => { $('#fAgain', el).onclick = () => findMyTv(0); });
    return;
  }
  const b = brands[i];
  const send = () => api('/ir/test', { body: { brand: b.id, key: 'vol_up' } }).catch((e) => toast(e.message, true));
  openSheet(`<h2>Find my TV</h2>
    <p class="sub">Point the phone at the TV. Trying code set <b>${i + 1} of ${brands.length}: ${esc(b.label)}</b> (Volume +).</p>
    <p style="font-size:18px;margin:14px 0">Did the TV's volume go up?</p>
    <div class="row gap"><button class="btn" id="fYes">Yes, it worked</button><button class="btn ghost" id="fNo">No, try next</button></div>
    <div class="row gap"><button class="btn ghost" id="fAgain">Send again</button></div>`, (el) => {
    $('#fYes', el).onclick = async () => {
      await api('/ir/test', { body: { brand: b.id, key: 'vol_down' } }).catch(() => {}); // put the volume back
      addDevice({ type: 'ir', brand: b.id });
    };
    $('#fNo', el).onclick = () => findMyTv(i + 1);
    $('#fAgain', el).onclick = send;
  });
  buzz(20);
  send();
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
  const body = { host: f.host, type: f.type, brand: f.brand, name: f.name || f.modelName || f.host, dlna: f.dlna, dialUrl: f.dialUrl, port: f.port, temp: tempAdd };
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
  document.body.classList.toggle('simple', !!settings.simple);
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
  if (s.currentApp !== undefined) { state.currentApp = s.currentApp; renderStrip(); }
  if (s.power === false) setStatus('', `${dev()?.name || 'TV'} · standby`);
  else if (s.power === true && dev()) setStatus('on', dev().name);
}

function handleEvent(m) {
  if (!dev() || m.deviceId !== dev().id) return;
  if (m.type === 'state') applyState(m.payload);
  if (m.type === 'pairing') pairingSheet(m.payload);
  if (m.type === 'paired') {
    setStatus('on', dev().name);
    toast('Connected ✓');
    if (pendingShare) { const u = pendingShare; pendingShare = null; openOnTv(u); }
  }
  if (m.type === 'error') toast(m.payload, true);
  if (m.type === 'adbPrompt') adbPromptShown();
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

// ------------------------------------------------------------ now open
const APP_NAMES = {
  'com.google.android.youtube.tv': 'YouTube', 'com.google.android.youtube.tvkids': 'YouTube Kids', 'com.google.android.youtube.tvmusic': 'YouTube Music',
  'com.netflix.ninja': 'Netflix', 'com.amazon.amazonvideo.livingroom': 'Prime Video', 'com.disney.disneyplus': 'Disney+',
  'com.spotify.tv.android': 'Spotify', 'com.google.android.tvlauncher': 'Home', 'com.google.android.apps.tv.launcherx': 'Home',
  'com.sony.dtv.tvx': 'TV', 'com.android.tv.settings': 'Settings', 'com.iqiyi.i18n.tv': 'iQIYI', 'com.vuclip.viu': 'Viu',
  'org.xbmc.kodi': 'Kodi', 'com.plexapp.android': 'Plex', 'com.google.android.tv': 'Live TV', 'com.android.vending': 'Play Store',
  'com.google.android.katniss': 'Google Assistant', 'com.android.chrome': 'Chrome',
};
function appLabel(pkg) {
  if (APP_NAMES[pkg]) return APP_NAMES[pkg];
  const parts = String(pkg).split('.').filter((p) => !/^(com|org|net|tv|android|app|apps|google|atv|androidtv|ui|main)$/i.test(p));
  const w = parts.sort((a, b) => b.length - a.length)[0] || pkg;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function renderStrip() {
  const app = state.currentApp;
  $('#nowOpen').classList.toggle('hidden', !app);
  if (app) $('#nowApp').textContent = appLabel(app);
  $('#sleepChip').classList.toggle('hidden', !sleep.end);
  $('#statusStrip').classList.toggle('hidden', !app && !sleep.end);
}

// ------------------------------------------------------------ open on TV
let pendingShare = null;
async function openOnTv(url) {
  if (!dev()) { pendingShare = url; deviceSheet(); return; }
  try {
    const r = await devApi('/open', { url });
    toast(r?.via === 'youtube' ? 'Opening in YouTube on the TV' : r?.via === 'dlna' ? 'Playing on TV' : 'Opening on the TV');
  } catch (e) { toast(e.message, true); }
}
function openLinkSheet(prefill = '') {
  openSheet(`<h2>Open on the TV</h2><p class="sub">Paste a YouTube, web or video link. Tip: in any app, tap Share › RemoteTV.</p>
    <div class="row gap"><input id="oUrl" type="url" value="${esc(prefill)}" placeholder="https://…" autocomplete="off"><button class="btn" id="oGo">Open</button></div>
    <div class="row gap"><button class="btn ghost" id="oPaste">Paste from clipboard</button></div>`, (el) => {
    const input = $('#oUrl', el);
    const go = () => {
      const m = /https?:\/\/\S+/i.exec(input.value);
      if (!m) return toast('Paste a link that starts with https://', true);
      closeSheet();
      openOnTv(m[0]);
    };
    $('#oGo', el).onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('#oPaste', el).onclick = async () => {
      try { input.value = (await navigator.clipboard.readText()).trim(); } catch { toast('Long-press the box and choose Paste', true); }
    };
  });
}
function handleShared(text) {
  const m = /https?:\/\/\S+/i.exec(text || '');
  if (!m) { if (text) toast('Shared text has no link', true); return; }
  if (dev() && $('#statusDot').classList.contains('on')) openOnTv(m[0]);
  else { pendingShare = m[0]; toast('Connecting to TV…'); }
}

// ------------------------------------------------------------ sleep timer
// The countdown runs on this phone: keep RemoteTV open (it can be in the
// background) and on the same Wi-Fi until the timer ends.
const sleep = safeJson(localStorage.getItem('remotetv.sleep'));
let sleepTick;
function saveSleep() { try { localStorage.setItem('remotetv.sleep', JSON.stringify(sleep)); } catch { /* ignore */ } }
async function startSleep(min) {
  sleep.end = Date.now() + min * 60000;
  sleep.device = dev()?.id;
  sleep.onTv = false;
  if (dev()?.adb) {
    try { await devApi('/adb/sleep', { minutes: min }); sleep.onTv = true; } catch { /* fall back to the phone timer */ }
  }
  saveSleep();
  runSleep();
  toast(`TV will turn off in ${min} min${sleep.onTv ? ' (timer runs on the TV)' : ''}`);
}
function cancelSleep(user = false) {
  if (user && sleep.onTv && sleep.device) api(`/devices/${sleep.device}/adb/sleep`, { body: { minutes: 0 } }).catch(() => {});
  delete sleep.end; delete sleep.onTv;
  saveSleep(); clearInterval(sleepTick); renderStrip();
}
function sleepLeftText() {
  const m = Math.max(0, Math.ceil((sleep.end - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}
function runSleep() {
  clearInterval(sleepTick);
  renderStrip();
  if (!sleep.end) return;
  const tick = async () => {
    if (sleep.end > Date.now()) { $('#sleepLeft').textContent = sleepLeftText(); return; }
    const target = state.devices.find((d) => d.id === sleep.device) || dev();
    const onTv = sleep.onTv;
    cancelSleep();
    if (!target || onTv) return; // the TV switches itself off
    try { await api(`/devices/${target.id}/key`, { body: { key: 'power_off' } }); }
    catch {
      try { await api(`/devices/${target.id}/key`, { body: { key: 'power' } }); }
      catch (e) { toast(`Sleep timer: ${e.message}`, true); return; }
    }
    toast('Sleep timer: TV turned off');
  };
  tick();
  sleepTick = setInterval(tick, 15000);
}
function sleepSheet() {
  if (!dev()) return deviceSheet();
  const opts = [15, 30, 45, 60, 90, 120];
  const label = (m) => (m < 60 ? `${m} min` : m === 90 ? '1½ hours' : `${m / 60} hour${m > 60 ? 's' : ''}`);
  openSheet(`<h2>Sleep timer</h2>
    <p class="sub">${sleep.end ? `The TV turns off in <b>${sleepLeftText()}</b>.` : 'Turn the TV off after:'}</p>
    <div class="choices">${opts.map((m) => `<button class="btn ghost" data-min="${m}">${label(m)}</button>`).join('')}</div>
    ${sleep.end ? '<div class="row gap"><button class="btn danger" id="slCancel">Cancel timer</button></div>' : ''}
    <p class="sub" style="margin-top:12px">${dev()?.adb ? 'Advanced mode is on: the TV runs the timer itself, so you can close the app.' : 'Keep RemoteTV open (the background is fine) and stay on the same Wi-Fi.'}</p>`, (el) => {
    $$('[data-min]', el).forEach((b) => b.onclick = () => { closeSheet(); startSleep(Number(b.dataset.min)); });
    if ($('#slCancel', el)) $('#slCancel', el).onclick = () => { closeSheet(); cancelSleep(true); toast('Sleep timer cancelled'); };
  });
}
$('#sleepChip').onclick = sleepSheet;

// ------------------------------------------------------------ scenes
// A scene is a list of steps run in order: key presses, an app, typed text, waits.
const KEY_CHOICES = [['power', 'Power'], ['home', 'Home'], ['back', 'Back'], ['ok', 'OK'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['vol_up', 'Volume +'], ['vol_down', 'Volume −'], ['mute', 'Mute'], ['ch_up', 'Channel +'], ['ch_down', 'Channel −'], ['input', 'Input / HDMI'],
  ['play_pause', 'Play / Pause'], ...[...'0123456789'].map((n) => [n, `Number ${n}`])];
const keyName = (k) => (KEY_CHOICES.find(([v]) => v === k) || [k, k])[1];
const scenes = (() => { const s = safeJson(localStorage.getItem('remotetv.scenes')); return Array.isArray(s.list) ? s.list : []; })();
function saveScenes() { try { localStorage.setItem('remotetv.scenes', JSON.stringify({ list: scenes })); } catch { /* ignore */ } }
const stepText = (s) => (s.key ? `${keyName(s.key)}${s.times > 1 ? ` × ${s.times}` : ''}` : s.app ? `Open ${s.app}` : s.text ? `Type “${s.text}”` : `Wait ${s.wait} s`);

function sceneMacro(sc) {
  const steps = [];
  for (const s of sc.steps) {
    if (s.key) for (let i = 0; i < Math.min(s.times || 1, 30); i++) steps.push({ key: s.key, delay: 300 });
    else if (s.app) steps.push({ app: s.app, delay: 1500 });
    else if (s.text) steps.push({ text: s.text, delay: 500 });
    else if (s.wait) steps.push({ delay: s.wait * 1000 });
  }
  return steps.slice(0, 50);
}
async function runScene(sc) {
  if (!dev()) return deviceSheet();
  toast(`Running “${sc.name}”`);
  try { await devApi('/macro', { steps: sceneMacro(sc) }); toast(`“${sc.name}” done`); }
  catch (e) { toast(e.message, true); }
}
function scenesSheet() {
  openSheet(`<h2>Scenes</h2><p class="sub">One tap runs several steps, e.g. turn on → HDMI → volume up → open YouTube.</p>
    <div class="card list">${scenes.map((sc, i) => `<div class="item"><div><b>${esc(sc.name)}</b><small>${esc(sc.steps.map(stepText).join(' → '))}</small></div>
      <div class="dev-actions"><button class="btn small" data-run="${i}">Run</button><button class="btn small ghost" data-ed="${i}">Edit</button></div></div>`).join('')
      || '<div class="item"><small>No scenes yet.</small></div>'}</div>
    <div class="row gap"><button class="btn" id="scNew">New scene</button></div>`, (el) => {
    $$('[data-run]', el).forEach((b) => b.onclick = () => { closeSheet(); runScene(scenes[b.dataset.run]); });
    $$('[data-ed]', el).forEach((b) => b.onclick = () => sceneEditor(Number(b.dataset.ed)));
    $('#scNew', el).onclick = () => sceneEditor(-1);
  });
}
function sceneEditor(idx) {
  const sc = idx >= 0 ? JSON.parse(JSON.stringify(scenes[idx])) : { name: '', steps: [] };
  const render = () => openSheet(`<h2>${idx >= 0 ? 'Edit scene' : 'New scene'}</h2>
    <div class="card">
      <label class="field">Name<div class="row"><input id="scName" value="${esc(sc.name)}" placeholder="Movie night"></div></label>
      <ul class="scene-steps">${sc.steps.map((s, i) => `<li><span>${i + 1}. ${esc(stepText(s))}</span><button class="btn small danger" data-rm="${i}" aria-label="Remove step">✕</button></li>`).join('') || '<li><small class="sub">Add steps below.</small></li>'}</ul>
    </div>
    <div class="card" style="margin-top:10px">
      <label class="field">Add a step<div class="row"><select id="stType"><option value="key">Press a key</option><option value="app">Open an app</option><option value="text">Type text</option><option value="wait">Wait</option></select></div></label>
      <div class="row" id="stKeyRow"><select id="stKey">${KEY_CHOICES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select><input id="stTimes" type="number" min="1" max="30" value="1" style="width:70px" aria-label="Times"></div>
      <div class="row hidden" id="stValRow"><input id="stVal"></div>
      <div class="row gap"><button class="btn ghost" id="stAdd">Add step</button></div>
    </div>
    <div class="row gap"><button class="btn" id="scSave">Save</button>${idx >= 0 ? '<button class="btn danger" id="scDel">Delete</button>' : ''}<button class="btn ghost" id="scBack">Cancel</button></div>`, (el) => {
    const type = $('#stType', el);
    const sync = () => {
      const t = type.value;
      $('#stKeyRow', el).classList.toggle('hidden', t !== 'key');
      $('#stValRow', el).classList.toggle('hidden', t === 'key');
      $('#stVal', el).placeholder = { app: 'YouTube', text: 'upin ipin', wait: 'Seconds, e.g. 5' }[t] || '';
      $('#stVal', el).inputMode = t === 'wait' ? 'numeric' : 'text';
    };
    type.onchange = sync;
    sync();
    $('#scName', el).oninput = (e) => { sc.name = e.target.value; };
    $$('[data-rm]', el).forEach((b) => b.onclick = () => { sc.steps.splice(Number(b.dataset.rm), 1); render(); });
    $('#stAdd', el).onclick = () => {
      const t = type.value;
      const v = $('#stVal', el).value.trim();
      if (sc.steps.length >= 20) return toast('Up to 20 steps', true);
      if (t === 'key') sc.steps.push({ key: $('#stKey', el).value, times: Math.max(1, Math.min(30, Number($('#stTimes', el).value) || 1)) });
      else if (!v) return toast('Fill in the value', true);
      else if (t === 'wait') sc.steps.push({ wait: Math.max(1, Math.min(10, Number(v) || 1)) });
      else sc.steps.push({ [t]: v });
      render();
    };
    $('#scSave', el).onclick = () => {
      sc.name = sc.name.trim() || `Scene ${scenes.length + 1}`;
      if (!sc.steps.length) return toast('Add at least one step', true);
      if (idx >= 0) scenes[idx] = sc; else scenes.push(sc);
      saveScenes();
      scenesSheet();
    };
    if ($('#scDel', el)) $('#scDel', el).onclick = () => { if (confirm('Delete this scene?')) { scenes.splice(idx, 1); saveScenes(); scenesSheet(); } };
    $('#scBack', el).onclick = scenesSheet;
  });
  render();
}

// ------------------------------------------------------------ air mouse
// Hold the pad and turn your wrist: the gyroscope's turn becomes arrow
// presses. A quick tap without moving = OK.
let airCleanup = null;
function airMouseSheet() {
  if (!dev()) return deviceSheet();
  openSheet(`<h2>Air Mouse</h2><p class="sub">Point the phone at the TV. <b>Hold</b> the pad and turn your wrist to move; <b>tap</b> for OK.</p>
    <div class="airpad" id="airPad"><div><b>Hold &amp; turn</b>tap = OK<div class="airdot" id="airDot"></div></div></div>
    <div class="row gap"><button class="btn ghost" id="airBack">Back</button><button class="btn ghost" id="airHome">Home</button></div>`, (el) => {
    const pad = $('#airPad', el);
    const dot = $('#airDot', el);
    let holding = false, ax = 0, ay = 0, last = 0, moved = false, downAt = 0;
    const stepDeg = () => 34 - settings.sens / 4; // degrees of turn per arrow press
    const onMotion = (e) => {
      if (!holding || !e.rotationRate) return;
      const now = performance.now();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      ax += -(e.rotationRate.alpha || 0) * dt; // turn left / right
      ay += -(e.rotationRate.beta || 0) * dt; // tilt up / down
      dot.style.transform = `translate(${Math.max(-60, Math.min(60, ax * 3))}px, ${Math.max(-60, Math.min(60, ay * 3))}px)`;
      const s = stepDeg();
      while (Math.abs(ax) >= s) { sendKey(ax > 0 ? 'right' : 'left'); ax -= Math.sign(ax) * s; moved = true; }
      while (Math.abs(ay) >= s) { sendKey(ay > 0 ? 'down' : 'up'); ay -= Math.sign(ay) * s; moved = true; }
    };
    const start = async (e) => {
      e.preventDefault();
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
        try { if (await DeviceMotionEvent.requestPermission() !== 'granted') { toast('Motion access denied', true); return; } } catch { /* ignore */ }
      }
      holding = true; moved = false; ax = 0; ay = 0; last = 0; downAt = Date.now();
      pad.classList.add('active');
    };
    const end = () => {
      if (!holding) return;
      holding = false;
      pad.classList.remove('active');
      dot.style.transform = '';
      if (!moved && Date.now() - downAt < 400) sendKey('ok');
    };
    if (typeof DeviceMotionEvent === 'undefined') { pad.innerHTML = '<div>This phone has no motion sensor.</div>'; return; }
    pad.addEventListener('pointerdown', start);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => pad.addEventListener(ev, end));
    airCleanup?.();
    window.addEventListener('devicemotion', onMotion);
    airCleanup = () => { window.removeEventListener('devicemotion', onMotion); airCleanup = null; };
    $('#airBack', el).onclick = () => sendKey('back');
    $('#airHome', el).onclick = () => sendKey('home');
  });
}

// ------------------------------------------------------------ ADB (advanced)
// Optional mode for Android TVs: the phone talks to the TV's debugging port
// (5555) to see the screen, tap on it, manage apps and read TV health.
const adbOk = () => !!(state.info?.adb && dev() && dev().host && !['sony_ir', 'ir'].includes(dev().type));
let adbView = null; // live screen loop state

function adbSetupSheet(then) {
  if (!adbOk()) { toast('ADB mode needs the Android app and a TV added over Wi-Fi', true); return; }
  openSheet(`<h2>Advanced mode (ADB)</h2>
    <p class="sub">See the TV screen on your phone, tap on it, take screenshots, open or stop apps and check memory, storage and temperature.</p>
    <div class="card"><b>On the TV, once:</b>
      <ol style="margin:8px 0 0;padding-left:20px;line-height:1.6">
        <li>Settings › Device Preferences › About › press <b>Build</b> 7 times.</li>
        <li>Settings › Device Preferences › <b>Developer options</b> › turn on <b>USB debugging</b> and, if listed, <b>Network debugging</b> / ADB over network.</li>
        <li>Tap <b>Connect</b> below, then on the TV tick <b>Always allow</b> and choose <b>OK</b>.</li>
      </ol></div>
    <p class="sub" style="margin-top:10px">⚠ While debugging is on, any device on your Wi-Fi that the TV has allowed can control it. Only use this at home, and turn it off in Developer options when you no longer need it.</p>
    <p class="sub" id="adbMsg" style="margin-top:6px"></p>
    <div class="row gap"><button class="btn" id="adbGo">Connect</button>${dev().adb ? '<button class="btn danger" id="adbOff">Turn off</button>' : ''}</div>`, (el) => {
    $('#adbGo', el).onclick = async () => {
      const btn = $('#adbGo', el);
      btn.disabled = true; btn.textContent = 'Connecting…';
      $('#adbMsg', el).textContent = 'Connecting to the TV…';
      try {
        await devApi('/adb/connect', {});
        dev().adb = true;
        toast('Advanced mode connected ✓');
        then ? then() : closeSheet();
      } catch (e) {
        $('#adbMsg', el).textContent = e.message;
        btn.disabled = false; btn.textContent = 'Try again';
      }
    };
    if ($('#adbOff', el)) $('#adbOff', el).onclick = async () => { await devApi('/adb/disconnect', {}).catch(() => {}); dev().adb = false; closeSheet(); toast('Advanced mode off'); };
  });
}
// Runs fn once ADB is connected, showing the setup sheet first if needed.
async function withAdb(fn) {
  if (!adbOk()) return dev() ? toast('Advanced mode needs the Android app and a Wi-Fi TV', true) : deviceSheet();
  if (!dev().adb) return adbSetupSheet(fn);
  fn();
}
function adbPromptShown() {
  const m = $('#adbMsg');
  if (m) m.innerHTML = '<b>Look at the TV:</b> tick “Always allow from this computer” and choose OK.';
  else toast('Look at the TV and allow debugging', false);
}

function screenSheet() {
  openSheet(`<h2>TV screen</h2>
    <div class="screen-wrap"><img id="scrImg" alt="TV screen" draggable="false"><div class="screen-msg" id="scrMsg">Loading the TV screen…</div></div>
    <p class="sub" style="margin-top:6px">Tap the picture to tap on the TV · swipe to scroll. Video apps with copy protection (Netflix…) show black.</p>
    <div class="row gap screen-btns">
      <button class="btn ghost" id="scrBack">Back</button><button class="btn ghost" id="scrHome">Home</button>
      <button class="btn" id="scrLive">Pause</button><button class="btn ghost" id="scrSave">Save</button>
    </div>`, (el) => {
    const img = $('#scrImg', el);
    const msg = $('#scrMsg', el);
    const view = { live: true, size: null, stop: false, lastPng: null };
    adbView = view;
    const load = async () => {
      if (view.stop) return;
      try {
        const s = await devApi('/adb/screen');
        if (view.stop) return;
        view.size = { w: s.w, h: s.h };
        view.lastPng = s.png;
        img.src = `data:image/png;base64,${s.png}`;
        msg.classList.add('hidden');
      } catch (e) {
        msg.textContent = e.message; msg.classList.remove('hidden');
        view.live = false; $('#scrLive', el).textContent = 'Live';
        return;
      }
      if (view.live) setTimeout(load, 250);
    };
    load();
    // Touch: tap = input tap, drag = input swipe, in TV pixel coordinates.
    let start = null;
    const toTv = (e) => {
      const r = img.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * view.size.w, y: ((e.clientY - r.top) / r.height) * view.size.h, t: Date.now() };
    };
    img.addEventListener('pointerdown', (e) => { if (view.size) { start = toTv(e); img.setPointerCapture(e.pointerId); } });
    img.addEventListener('pointerup', async (e) => {
      if (!start || !view.size) return;
      const end = toTv(e);
      const s0 = start; start = null;
      buzz();
      const far = Math.hypot(end.x - s0.x, end.y - s0.y) > view.size.w * 0.02;
      try {
        if (far) await devApi('/adb/swipe', { x1: s0.x, y1: s0.y, x2: end.x, y2: end.y, ms: Math.max(120, Math.min(1500, end.t - s0.t)) });
        else await devApi('/adb/tap', { x: end.x, y: end.y });
        if (!view.live) setTimeout(load, 400);
      } catch (err) { toast(err.message, true); }
    });
    $('#scrBack', el).onclick = () => sendKey('back');
    $('#scrHome', el).onclick = () => sendKey('home');
    $('#scrLive', el).onclick = (e) => {
      view.live = !view.live;
      e.target.textContent = view.live ? 'Pause' : 'Live';
      if (view.live) load();
    };
    $('#scrSave', el).onclick = async () => {
      if (!view.lastPng) return;
      try {
        if (window.NativeBackend?.saveImage) { await window.NativeBackend.saveImage(view.lastPng, `tv-${Date.now()}.png`); toast('Saved to Pictures ✓'); return; }
        const a = Object.assign(document.createElement('a'), { href: img.src, download: `tv-${Date.now()}.png` });
        a.click();
      } catch (err) { toast(err.message, true); }
    };
  });
}
function stopScreen() { if (adbView) { adbView.stop = true; adbView = null; } }

async function tvAppsSheet() {
  openSheet('<h2>TV apps</h2><p class="sub">Reading apps from the TV…</p>');
  try {
    const apps = await devApi('/adb/apps');
    const row = (a) => `<div class="item"><div><b>${esc(appLabel(a.id))}</b><small>${esc(a.id)}${a.user ? ' · installed by you' : ''}</small></div>
      <div class="dev-actions"><button class="btn small" data-open="${esc(a.id)}">Open</button><button class="btn small ghost" data-stop="${esc(a.id)}">Stop</button></div></div>`;
    $('#sheetBody').innerHTML = `<h2>TV apps</h2><p class="sub">${apps.length} apps. “Stop” force-closes an app that is stuck or using memory.</p>
      <div class="card list">${apps.map(row).join('')}</div>`;
    $$('[data-open]').forEach((b) => b.onclick = async () => { try { await devApi('/adb/app', { id: b.dataset.open }); closeSheet(); toast(`Opening ${appLabel(b.dataset.open)}`); } catch (e) { toast(e.message, true); } });
    $$('[data-stop]').forEach((b) => b.onclick = async () => { try { await devApi('/adb/app', { id: b.dataset.stop, action: 'stop' }); toast(`Stopped ${appLabel(b.dataset.stop)}`); } catch (e) { toast(e.message, true); } });
  } catch (e) { $('#sheetBody').innerHTML = `<h2>TV apps</h2><p class="sub">${esc(e.message)}</p>`; }
}

async function tvHealthSheet() {
  openSheet('<h2>TV health</h2><p class="sub">Reading from the TV…</p>');
  try {
    const i = await devApi('/adb/info');
    const usedMb = i.memTotalMb - i.memFreeMb;
    const pct = i.memTotalMb ? Math.round((usedMb / i.memTotalMb) * 100) : 0;
    const up = i.uptimeSec >= 86400 ? `${Math.floor(i.uptimeSec / 86400)} d ${Math.floor((i.uptimeSec % 86400) / 3600)} h` : `${Math.floor(i.uptimeSec / 3600)} h ${Math.floor((i.uptimeSec % 3600) / 60)} min`;
    const item = (k, v) => `<div class="item"><div><b>${k}</b></div><span>${esc(v ?? '–')}</span></div>`;
    $('#sheetBody').innerHTML = `<h2>TV health</h2>
      <div class="card"><b>Memory</b><div class="meter"><div style="width:${pct}%"></div></div><small class="sub">${usedMb} MB used of ${i.memTotalMb} MB (${pct}%)${pct > 85 ? ' — close unused apps (TV apps › Stop)' : ''}</small></div>
      <div class="card list" style="margin-top:10px">
        ${item('Model', [i.brand, i.model].filter(Boolean).join(' '))}${item('Android', i.android)}${item('Running for', up)}
        ${item('Storage free', i.storage ? `${i.storage.free} of ${i.storage.size}` : null)}${item('Temperature', i.tempC ? `${Math.round(i.tempC)} °C` : null)}
        ${item('On screen', i.topApp ? appLabel(i.topApp) : null)}
      </div>`;
  } catch (e) { $('#sheetBody').innerHTML = `<h2>TV health</h2><p class="sub">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------ draw on TV
// Needs RemoteTV itself installed on the TV (the same APK acts as receiver). Strokes
// are sent live as 0..1 coordinates and drawn above whatever the TV shows.
const DRAW_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];
const draw = { color: DRAW_COLORS[0], size: 0.006, id: 1, queue: Promise.resolve(), pendingText: null };

function drawSend(ops) {
  draw.queue = draw.queue.then(() => devApi('/draw/send', { ops })).catch((e) => toast(e.message, true));
  return draw.queue;
}

async function drawOnTv() {
  if (!state.info?.draw) return toast('Draw on TV needs the RemoteTV Android app', true);
  if (!dev() || /^infra-red/.test(dev().host || '')) return dev() ? toast('Draw on TV needs a TV added over Wi-Fi', true) : deviceSheet();
  openSheet('<h2>Draw on TV</h2><p class="sub">Connecting to RemoteTV on the TV…</p>');
  try {
    const r = await devApi('/draw/connect', {});
    if (r.paired) drawCanvasSheet(r);
    else drawPairSheet(r);
  } catch (e) {
    if (/not running|Install it first/i.test(e.message)) helperInstallSheet();
    else if (/not allowed to draw/i.test(e.message)) helperInstallSheet(e.message);
    else $('#sheetBody').innerHTML = `<h2>Draw on TV</h2><p class="sub">${esc(e.message)}</p>`;
  }
}

function drawPairSheet(size) {
  openSheet(`<h2>Pair with the TV</h2><p class="sub">A 6-digit code is now on the TV screen. Type it here (only needed once).</p>
    <div class="row gap"><input id="dCode" inputmode="numeric" maxlength="7" autocomplete="one-time-code" style="font-size:22px;letter-spacing:.3em;text-align:center"><button class="btn" id="dGo">Pair</button></div>`, (el) => {
    const input = $('#dCode', el);
    setTimeout(() => input.focus(), 250);
    const go = async () => {
      try { await devApi('/draw/pair', { code: input.value }); toast('Paired ✓'); drawCanvasSheet(size); }
      catch (e) { toast(e.message, true); }
    };
    $('#dGo', el).onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

function helperInstallSheet(reason) {
  const viaAdb = adbOk();
  openSheet(`<h2>Install RemoteTV on the TV</h2>
    <p class="sub">${esc(reason || 'Drawing on the TV needs this same RemoteTV app installed on the TV too (one time). On the TV it becomes the drawing receiver.')}</p>
    ${viaAdb ? `<div class="card"><b>Easiest: install from this phone</b><small class="sub" style="display:block;margin-top:4px">Copies this app to the TV over Advanced mode (ADB) and allows it to draw over other apps.</small>
      <div class="row gap"><button class="btn" id="hAdb">${dev().adb ? 'Install on the TV now' : 'Set up Advanced mode, then install'}</button></div><p class="sub" id="hMsg"></p></div>` : ''}
    <div class="card" style="margin-top:10px"><b>Or install on the TV by hand</b>
      <ol style="margin:8px 0 0;padding-left:20px;line-height:1.6">
        <li>On the TV install <b>Downloader</b> from the Play Store.</li>
        <li>In Downloader open <b>github.com/imuhakim/remotetv/releases/latest</b> and install <b>RemoteTV-v…apk</b> (the same file as on your phone).</li>
        <li>Open <b>RemoteTV</b> on the TV and choose <b>Allow drawing over other apps</b>.</li>
      </ol></div>
    <div class="row gap"><button class="btn ghost" id="hRetry">Try again</button></div>`, (el) => {
    $('#hRetry', el).onclick = drawOnTv;
    const btn = $('#hAdb', el);
    if (!btn) return;
    const install = async () => {
      const msg = $('#hMsg');
      try {
        if (msg) msg.textContent = 'Copying RemoteTV to the TV… (about 30 seconds)';
        const r = await devApi('/adb/install-helper', {});
        toast(r.started ? 'Installed on the TV ✓' : 'Installed. Open RemoteTV once on the TV.');
        setTimeout(drawOnTv, 1500);
      } catch (e) { if (msg) msg.textContent = e.message; else toast(e.message, true); }
    };
    btn.onclick = () => (dev().adb ? install() : adbSetupSheet(() => helperInstallSheet()));
  });
}

function drawCanvasSheet(size) {
  const ratio = size?.w && size?.h ? size.w / size.h : 16 / 9;
  openSheet(`<h2>Draw on TV</h2>
    <div class="draw-wrap" style="aspect-ratio:${ratio}"><img id="dBg" alt="" class="hidden"><canvas id="dCanvas"></canvas></div>
    <div class="draw-tools">
      ${DRAW_COLORS.map((c) => `<button class="swatch${c === draw.color ? ' on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}
      <select id="dSize" aria-label="Pen size"><option value="0.003">Thin</option><option value="0.006">Medium</option><option value="0.012">Thick</option><option value="0.025">Marker</option></select>
    </div>
    <div class="row gap draw-btns">
      <button class="btn ghost" id="dUndo">Undo</button><button class="btn ghost" id="dClear">Clear</button>
      <button class="btn ghost" id="dText">Text</button><button class="btn ghost" id="dMsg">Message</button>
    </div>
    <div class="row gap draw-btns">
      ${dev().adb ? '<button class="btn ghost" id="dPic">TV picture</button>' : ''}<button class="btn danger" id="dHide">Remove from TV</button>
    </div>
    <p class="sub" style="margin-top:6px">Your drawing appears on top of whatever the TV is showing.</p>`, (el) => {
    const cv = $('#dCanvas', el);
    const ctx = cv.getContext('2d');
    const strokes = []; // local mirror for undo / redraw
    const fit = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.round(r.width * devicePixelRatio);
      cv.height = Math.round(r.height * devicePixelRatio);
      redraw();
    };
    const redraw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const s of strokes) {
        if (s.text) {
          ctx.fillStyle = s.c; ctx.font = `bold ${s.s * cv.height}px sans-serif`; ctx.fillText(s.text, s.x * cv.width, s.y * cv.height);
          continue;
        }
        ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(1.5, s.w * cv.width); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * cv.width, y * cv.height) : ctx.moveTo(x * cv.width, y * cv.height)));
        if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * cv.width + 0.1, s.pts[0][1] * cv.height);
        ctx.stroke();
      }
    };
    requestAnimationFrame(fit);
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
    };
    let cur = null, buf = [], flushT = null;
    const flush = () => {
      clearTimeout(flushT); flushT = null;
      if (cur && buf.length) { drawSend([{ t: 'move', id: cur.id, p: buf.flat().map((v) => Math.round(v * 10000) / 10000) }]); buf = []; }
    };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      if (draw.pendingText) {
        const t = { text: draw.pendingText, x, y, c: draw.color, s: 0.07 };
        draw.pendingText = null;
        strokes.push(t); redraw();
        drawSend([{ t: 'text', text: t.text, x, y, c: t.c, s: t.s }]);
        return;
      }
      cv.setPointerCapture(e.pointerId);
      cur = { id: draw.id++, c: draw.color, w: draw.size, pts: [[x, y]] };
      strokes.push(cur);
      redraw();
      drawSend([{ t: 'begin', id: cur.id, c: cur.c, w: cur.w, x, y }]);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!cur) return;
      const p = pos(e);
      cur.pts.push(p);
      buf.push(p);
      redraw();
      if (!flushT) flushT = setTimeout(flush, 40);
    });
    const end = () => { if (!cur) return; flush(); drawSend([{ t: 'end', id: cur.id }]); cur = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    $$('[data-color]', el).forEach((b) => b.onclick = () => {
      draw.color = b.dataset.color;
      $$('[data-color]', el).forEach((x) => x.classList.toggle('on', x === b));
    });
    const sizeSel = $('#dSize', el);
    sizeSel.value = String(draw.size);
    sizeSel.onchange = () => { draw.size = Number(sizeSel.value); };
    $('#dUndo', el).onclick = () => { strokes.pop(); redraw(); drawSend([{ t: 'undo' }]); };
    $('#dClear', el).onclick = () => { strokes.length = 0; redraw(); drawSend([{ t: 'clear' }]); };
    $('#dHide', el).onclick = () => { strokes.length = 0; redraw(); drawSend([{ t: 'hide' }]); toast('Removed from the TV'); };
    $('#dText', el).onclick = () => {
      const t = prompt('Text to put on the TV');
      if (t && t.trim()) { draw.pendingText = t.trim().slice(0, 80); toast('Now tap where the text should go'); }
    };
    $('#dMsg', el).onclick = () => {
      const t = prompt('Message to show on the TV (20 seconds)');
      if (t && t.trim()) { drawSend([{ t: 'msg', text: t.trim().slice(0, 200), secs: 20 }]); toast('Message shown on the TV'); }
    };
    const pic = $('#dPic', el);
    if (pic) pic.onclick = async () => {
      try {
        const s = await devApi('/adb/screen');
        const img = $('#dBg', el);
        img.src = `data:image/png;base64,${s.png}`;
        img.classList.remove('hidden');
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ------------------------------------------------------------ More sheet
const MORE_ICONS = {
  open: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  sleep: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  scenes: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 8l3-5h4l-3 5M10 8l3-5h4l-3 5"/>',
  air: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 6v4"/>',
  input: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  numbers: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  simple: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="4"/>',
  draw: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M10 9l4 2-4 2z"/>',
  tvapps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  health: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  adb: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};
function moreSheet() {
  const items = [['open', 'Open on the TV'], ...(state.info?.draw ? [['draw', 'Draw on TV']] : []), ['sleep', 'Sleep timer'], ['scenes', 'Scenes'], ['air', 'Air Mouse'], ['input', 'Input'],
    ['keyboard', 'Keyboard'], ['numbers', 'Numbers'], ['simple', 'Simple mode'], ['settings', 'TV settings']];
  if (state.info?.adb) items.push(['screen', 'TV screen'], ['tvapps', 'TV apps'], ['health', 'TV health'], ['adb', 'Advanced (ADB)']);
  const on = (k) => (k === 'simple' && settings.simple) || (k === 'sleep' && sleep.end) || (k === 'adb' && dev()?.adb);
  openSheet(`<h2>More</h2><div class="more-grid">${items.map(([k, n]) => `<button data-more="${k}" class="${on(k) ? 'on' : ''}"><svg viewBox="0 0 24 24">${MORE_ICONS[k]}</svg>${n}</button>`).join('')}</div>`, (el) => {
    $$('[data-more]', el).forEach((b) => b.onclick = () => {
      const k = b.dataset.more;
      if (k === 'open') return openLinkSheet();
      if (k === 'draw') return drawOnTv();
      if (k === 'sleep') return sleepSheet();
      if (k === 'scenes') return scenesSheet();
      if (k === 'air') return airMouseSheet();
      if (k === 'screen') return withAdb(screenSheet);
      if (k === 'tvapps') return withAdb(tvAppsSheet);
      if (k === 'health') return withAdb(tvHealthSheet);
      if (k === 'adb') return adbSetupSheet();
      if (k === 'keyboard') return (dev() ? keyboardSheet() : deviceSheet());
      if (k === 'numbers') return $('#btnNumpad').click();
      if (k === 'simple') {
        settings.simple = !settings.simple;
        saveSettings(); applySettings(); closeSheet();
        return toast(settings.simple ? 'Simple mode on' : 'Simple mode off');
      }
      closeSheet();
      sendKey(k === 'input' ? 'input' : 'settings');
    });
  });
}
$('#btnMore').onclick = moreSheet;

// --------------------------------------------------------------- settings
function renderDeviceList() {
  const el = $('#deviceList');
  el.innerHTML = state.devices.map((d) => `
    <div class="item"><div><b>${esc(d.name)}<span class="tag">${esc(d.temp ? 'shop' : d.type)}</span></b><small>${esc(hostLabel(d))}${d.mac ? ` · ${esc(d.mac)}` : ''}${d.dlna ? ' · cast ready' : ''}${d.temp ? ` · ${esc(tempLeft(d))}` : ''}</small></div>
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
  $('#setSimple').checked = !!settings.simple;
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
bind('#setSimple', 'simple');
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
    for (const src of ['vendor/forge.min.js', 'vendor/protobuf.min.js', 'vendor/protos.js', 'native/ircodes.js', 'native/drivers.js', 'native/adb.js', 'native/helper.js', 'native/backend.js']) await loadScript(src);
    document.body.classList.add('native');
  }
  applySettings();
  loadShortcuts();
  connectWs();
  runSleep();
  window.NativeBackend?.onShared?.(handleShared);
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    state.info = await api('/info');
    if (state.info.hasIr) state.irBrands = await api('/ir/brands').catch(() => []);
    $('#hubAddr').textContent = NATIVE ? 'Running on this phone — no PC needed' : `${state.info.hub}  ·  HTTPS :8443 for voice`;
    await loadDevices();
    const last = state.devices.find((d) => d.id === state.info.lastDeviceId) || state.devices[0];
    if (last) selectDevice(last);
  } catch (e) { toast(`Hub unreachable: ${e.message}`, true); }
})();
