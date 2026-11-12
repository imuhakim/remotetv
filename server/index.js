'use strict';
// RemoteTV hub: serves the phone PWA and bridges it to TVs on the LAN.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const cast = require('./cast');
const { wake } = require('./wol');
const { discover } = require('./discovery');
const { KEYS } = require('./keys');

const DRIVERS = {
  sony: require('./drivers/sony'),
  androidtv: require('./drivers/androidtv'),
  roku: require('./drivers/roku'),
  lg: require('./drivers/lg'),
  samsung: require('./drivers/samsung'),
};

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const PIN = process.env.REMOTETV_PIN || '';
const MEDIA_DIR = path.join(store.DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // deviceId -> { driver, state, status }
const sockets = new Set();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
}

function emitterFor(device) {
  return (event, payload) => {
    const sess = sessions.get(device.id);
    if (event === 'persist') { store.update(device.id, payload); return; }
    if (event === 'state' && sess) sess.state = { ...sess.state, ...payload };
    broadcast({ type: event, deviceId: device.id, payload });
  };
}

async function connect(device) {
  const old = sessions.get(device.id);
  if (old) old.driver.close();
  const Driver = DRIVERS[device.type];
  if (!Driver) throw new Error(`Unsupported TV type: ${device.type}`);
  const driver = new Driver(device, emitterFor(device));
  const sess = { driver, state: {}, status: 'connecting' };
  sessions.set(device.id, sess);
  try {
    const r = await driver.connect();
    sess.status = r === 'pairing' ? 'pairing' : 'connected';
  } catch (e) {
    sess.status = 'error';
    throw e;
  }
  store.lastDeviceId = device.id;
  return sess;
}

async function session(id) {
  const device = store.get(id);
  if (!device) throw httpError(404, 'Unknown device');
  let s = sessions.get(id);
  if (!s || s.status === 'error') s = await connect(device);
  if (s.status === 'pairing') throw httpError(409, 'Finish pairing first');
  return { device, driver: s.driver, sess: s };
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function lanIp(near) {
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal);
  if (near) {
    const pre = near.split('.').slice(0, 3).join('.');
    const hit = nets.find((n) => n.address.startsWith(pre + '.'));
    if (hit) return hit.address;
  }
  return nets[0]?.address || '127.0.0.1';
}

// --------------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api', (req, res, next) => {
  if (!PIN || req.get('x-pin') === PIN) return next();
  res.status(401).json({ error: 'PIN required' });
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .then((out) => res.json(out ?? { ok: true }))
  .catch((e) => res.status(e.status || 502).json({ error: e.message }));

app.get('/api/info', wrap(() => ({
  keys: KEYS,
  drivers: Object.fromEntries(Object.entries(DRIVERS).map(([k, D]) => [k, { needs: D.needs }])),
  hub: `http://${lanIp()}:${PORT}`,
  pin: !!PIN,
  lastDeviceId: store.lastDeviceId,
})));

app.get('/api/discover', wrap(async (req) => discover(Number(req.query.timeout) || 3000)));

app.get('/api/devices', wrap(() => store.list().map((d) => ({
  ...store.publicView(d),
  status: sessions.get(d.id)?.status || 'idle',
  state: sessions.get(d.id)?.state || {},
}))));

app.post('/api/devices', wrap(async (req) => {
  const { host, type, name, psk, mac, dlna, dialUrl, port } = req.body || {};
  if (!host || !DRIVERS[type]) throw httpError(400, 'host and a valid type are required');
  const d = store.add({ host, type, name: name || `${type} ${host}`, psk, mac, dlna, dialUrl, port });
  return store.publicView(d);
}));

app.patch('/api/devices/:id', wrap(async (req) => {
  const allowed = ['name', 'psk', 'mac', 'dlna', 'dialUrl', 'shortcuts'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const d = store.update(req.params.id, patch);
  if (!d) throw httpError(404, 'Unknown device');
  return store.publicView(d);
}));

app.delete('/api/devices/:id', wrap(async (req) => {
  sessions.get(req.params.id)?.driver.close();
  sessions.delete(req.params.id);
  store.remove(req.params.id);
}));

app.post('/api/devices/:id/connect', wrap(async (req) => {
  const d = store.get(req.params.id);
  if (!d) throw httpError(404, 'Unknown device');
  const s = await connect(d);
  return { status: s.status, state: s.state, keys: s.driver.supportedKeys?.() || [] };
}));

app.post('/api/devices/:id/pair', wrap(async (req) => {
  const s = sessions.get(req.params.id);
  if (!s?.driver.pair) throw httpError(400, 'This TV does not use a pairing code');
  await s.driver.pair(req.body.code);
  s.status = 'connected';
}));

app.post('/api/devices/:id/key', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  await driver.sendKey(String(req.body.key), req.body.mode);
}));

app.post('/api/devices/:id/text', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  if (!driver.sendText) throw httpError(501, 'Keyboard input is not supported by this TV protocol');
  await driver.sendText(String(req.body.text || ''));
}));

app.post('/api/devices/:id/volume', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  if (!driver.setVolume) throw httpError(501, 'Direct volume level not supported; use +/-');
  await driver.setVolume(Number(req.body.level));
}));

app.post('/api/devices/:id/pointer', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  if (req.body.click) return driver.click ? driver.click() : driver.sendKey('ok');
  if (!driver.move) throw httpError(501, 'Pointer not supported');
  await driver.move(Math.round(req.body.dx || 0), Math.round(req.body.dy || 0));
}));

app.get('/api/devices/:id/apps', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  return driver.listApps ? driver.listApps() : [];
}));

app.post('/api/devices/:id/launch', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  await driver.launchApp(String(req.body.id));
}));

app.get('/api/devices/:id/inputs', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  return driver.listInputs ? driver.listInputs() : [];
}));

app.post('/api/devices/:id/input', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  if (!driver.setInput) return driver.sendKey('input');
  await driver.setInput(req.body.id);
}));

app.post('/api/devices/:id/wake', wrap(async (req) => {
  const d = store.get(req.params.id);
  if (!d?.mac) throw httpError(400, 'Save the TV MAC address in Settings to use Wake-on-LAN');
  await wake(d.mac);
}));

// Macro: [{key}, {text}, {app}, {delay}] run in order.
app.post('/api/devices/:id/macro', wrap(async (req) => {
  const { driver } = await session(req.params.id);
  const steps = Array.isArray(req.body.steps) ? req.body.steps.slice(0, 50) : [];
  for (const s of steps) {
    if (s.key) await driver.sendKey(s.key);
    else if (s.text && driver.sendText) await driver.sendText(s.text);
    else if (s.app) await driver.launchApp(s.app);
    await new Promise((r) => setTimeout(r, Math.min(Number(s.delay) || 250, 10000)));
  }
}));

// ------------------------------------------------------------------- cast
function dlnaOf(id) {
  const d = store.get(id);
  if (!d) throw httpError(404, 'Unknown device');
  if (!d.dlna) throw httpError(400, 'No DLNA renderer known for this TV. Run "Scan" so it is detected.');
  return d;
}

app.post('/api/devices/:id/cast/upload', wrap(async (req) => {
  const d = dlnaOf(req.params.id);
  const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0];
  const name = decodeURIComponent(req.get('x-filename') || 'media');
  const ext = path.extname(name).replace(/[^.\w]/g, '').slice(0, 6) || '';
  const file = crypto.randomBytes(8).toString('hex') + ext;
  // Stream to disk so multi-GB phone videos never sit in memory.
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(path.join(MEDIA_DIR, file));
    req.pipe(out).on('finish', resolve).on('error', reject);
    req.on('error', reject);
  });
  const url = `http://${lanIp(d.host)}:${PORT}/media/${file}`;
  await cast.play(d.dlna, url, mime, name);
  return { url };
}));

app.post('/api/devices/:id/cast/url', wrap(async (req) => {
  const d = dlnaOf(req.params.id);
  const { url, mime } = req.body;
  if (!/^https?:\/\//.test(url || '')) throw httpError(400, 'A http(s) media URL is required');
  await cast.play(d.dlna, url, mime || 'video/mp4', url.split('/').pop());
}));

app.post('/api/devices/:id/cast/youtube', wrap(async (req) => {
  const d = store.get(req.params.id);
  if (!d) throw httpError(404, 'Unknown device');
  const vid = cast.youtubeId(req.body.url);
  const s = sessions.get(d.id);
  if (s?.driver.castYouTube) return s.driver.castYouTube(vid);
  if (d.dialUrl) return cast.dialYouTube(d.dialUrl, vid);
  if (s?.driver.openUrl) return s.driver.openUrl(`https://www.youtube.com/watch?v=${vid}`);
  throw httpError(400, 'No way to reach YouTube on this TV (scan to find its DIAL service)');
}));

// "Open on the TV": YouTube links go to the YouTube app, media files to the
// DLNA player, anything else to the TV's browser / app links.
const MEDIA_MIME = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', m3u8: 'application/vnd.apple.mpegurl',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
app.post('/api/devices/:id/open', wrap(async (req) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Paste a link that starts with http:// or https://');
  const d = store.get(req.params.id);
  if (!d) throw httpError(404, 'Unknown device');
  let yt = null;
  if (/youtu.?be/i.test(url)) try { yt = cast.youtubeId(url); } catch { /* not a video link */ }
  if (yt) {
    const s = sessions.get(d.id);
    if (s?.driver.castYouTube) { await s.driver.castYouTube(yt); return { via: 'youtube' }; }
    if (d.dialUrl) { await cast.dialYouTube(d.dialUrl, yt); return { via: 'youtube' }; }
  }
  const mime = MEDIA_MIME[url.split(/[?#]/)[0].split('.').pop().toLowerCase()];
  if (mime && d.dlna) { await cast.play(d.dlna, url, mime, url.split('/').pop()); return { via: 'dlna' }; }
  const { driver } = await session(d.id);
  if (driver.openUrl) { await driver.openUrl(url); return { via: 'browser' }; }
  throw httpError(501, 'This TV cannot open links over this connection');
}));

app.post('/api/devices/:id/cast/control', wrap(async (req) => {
  const d = dlnaOf(req.params.id);
  await cast.control(d.dlna, req.body.action, req.body.value);
}));

app.get('/api/devices/:id/cast/status', wrap(async (req) => cast.status(dlnaOf(req.params.id).dlna)));

// Media is served with DLNA-friendly headers; files expire after 6 hours.
app.use('/media', express.static(MEDIA_DIR, {
  setHeaders: (res) => {
    res.set('transferMode.dlna.org', 'Streaming');
    res.set('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000');
  },
}));
setInterval(() => {
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    const p = path.join(MEDIA_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600e3) fs.rmSync(p, { force: true });
  }
}, 3600e3).unref();

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ------------------------------------------------------------- listeners
function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    if (PIN && new URL(req.url, 'http://x').searchParams.get('pin') !== PIN) return ws.close(4001, 'PIN');
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    for (const [id, s] of sessions) ws.send(JSON.stringify({ type: 'state', deviceId: id, payload: s.state }));
  });
}

function start() {
  const server = http.createServer(app);
  attachWs(server);
  server.listen(PORT, () => {
    console.log(`RemoteTV hub ready`);
    console.log(`  Phone (same Wi-Fi): http://${lanIp()}:${PORT}`);
  });

  // HTTPS lets phones use voice search and keep-screen-awake (secure-context APIs).
  if (HTTPS_PORT) {
    try {
      const certFile = path.join(store.DIR, 'https-cert.json');
      let pems;
      try { pems = JSON.parse(fs.readFileSync(certFile, 'utf8')); } catch {
        pems = require('selfsigned').generate([{ name: 'commonName', value: 'remotetv.local' }], { days: 3650, keySize: 2048 });
        fs.writeFileSync(certFile, JSON.stringify(pems));
      }
      const secure = https.createServer({ key: pems.private, cert: pems.cert }, app);
      attachWs(secure);
      secure.listen(HTTPS_PORT, () => console.log(`  HTTPS (voice + wake lock): https://${lanIp()}:${HTTPS_PORT}`));
    } catch (e) {
      console.warn('HTTPS disabled:', e.message);
    }
  }
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
