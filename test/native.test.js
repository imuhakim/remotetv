'use strict';
// Runs the APK's in-app backend (public/native/*.js) inside Node with a mock
// of the RemoteTv native plugin backed by real TLS sockets, against a fake
// Android TV that implements the Remote v2 pairing + remote protocol.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const forge = require('node-forge');
const selfsigned = require('selfsigned');

const root = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(root, 'scripts', 'vendor.js')]);

// ------------------------------------------------------------ fake TV
const protosCtx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/vendor/protos.js'), 'utf8'), protosCtx);
const TV_PROTOS = protosCtx.window.TV_PROTOS;
const Pairing = protobuf.parse(TV_PROTOS.pairing).root.lookupType('pairing.PairingMessage');
const Remote = protobuf.parse(TV_PROTOS.remote).root.lookupType('remote.RemoteMessage');
const KeyEnum = protobuf.parse(TV_PROTOS.remote).root.lookupEnum('remote.RemoteKeyCode').values;

function frames(onMsg, Type) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const r = protobuf.Reader.create(buf);
      let len;
      try { len = r.uint32(); } catch { return; }
      if (buf.length < r.pos + len) return;
      const msg = Type.decode(buf.subarray(r.pos, r.pos + len));
      buf = buf.subarray(r.pos + len);
      onMsg(msg);
    }
  };
}
const send = (sock, Type, payload) => sock.write(Type.encodeDelimited(Type.create(payload)).finish());

function modExp(cert) {
  // Same derivation the TV uses (and androidtv-remote's PairingManager).
  return [Buffer.from(cert.modulus, 'hex'), Buffer.from(cert.exponent.slice(2).padStart(6, '0'), 'hex')];
}

function fakeAndroidTv() {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'atv' }], { keySize: 2048, days: 30 });
  const opts = { key: pems.private, cert: pems.cert, requestCert: true, rejectUnauthorized: false };
  const tv = { code: null, keys: [], links: [], configured: false, pairedClients: new Set() };

  tv.pairing = tls.createServer(opts, (sock) => {
    sock.on('data', frames((m) => {
      if (m.pairingRequest) send(sock, Pairing, { pairingRequestAck: { serverName: 'atv' }, status: 200, protocolVersion: 2 });
      else if (m.pairingOption) send(sock, Pairing, { pairingOption: { preferredRole: 1, inputEncodings: [{ type: 3, symbolLength: 6 }] }, status: 200, protocolVersion: 2 });
      else if (m.pairingConfiguration) {
        const nonce = crypto.randomBytes(2);
        const [cm, ce] = modExp(sock.getPeerCertificate());
        const [sm, se] = modExp(sock.getCertificate());
        tv.expected = crypto.createHash('sha256').update(Buffer.concat([cm, ce, sm, se, nonce])).digest();
        tv.code = (tv.expected.subarray(0, 1).toString('hex') + nonce.toString('hex')).toUpperCase();
        tv.clientFp = sock.getPeerCertificate().fingerprint256;
        send(sock, Pairing, { pairingConfigurationAck: {}, status: 200, protocolVersion: 2 });
      } else if (m.pairingSecret) {
        if (Buffer.from(m.pairingSecret.secret).equals(tv.expected)) {
          tv.pairedClients.add(tv.clientFp);
          send(sock, Pairing, { pairingSecretAck: { secret: tv.expected }, status: 200, protocolVersion: 2 });
        } else send(sock, Pairing, { status: 402, protocolVersion: 2 });
      }
    }, Pairing));
  });

  tv.remote = tls.createServer(opts, (sock) => {
    if (!tv.pairedClients.has(sock.getPeerCertificate().fingerprint256)) { sock.destroy(); return; }
    sock.on('data', frames((m) => {
      if (m.remoteConfigure) { tv.configured = true; send(sock, Remote, { remoteSetActive: {} }); }
      else if (m.remoteSetActive) {
        send(sock, Remote, { remoteStart: { started: true } });
        send(sock, Remote, { remoteSetVolumeLevel: { volumeMax: 100, volumeLevel: 24, volumeMuted: false } });
        send(sock, Remote, { remotePingRequest: { val1: 7 } });
      } else if (m.remotePingResponse) tv.pong = m.remotePingResponse.val1;
      else if (m.remoteKeyInject) tv.keys.push(m.remoteKeyInject.keyCode);
      else if (m.remoteAppLinkLaunchRequest) tv.links.push(m.remoteAppLinkLaunchRequest.appLink);
    }, Remote));
    send(sock, Remote, { remoteConfigure: { code1: 622, deviceInfo: { model: 'TV', vendor: 'Sony' } } });
  });
  return tv;
}

// ------------------------------------------------ app runtime in a sandbox
function mockPlugin() {
  const listeners = {};
  const conns = new Map();
  let next = 1;
  const fire = (name, ev) => (listeners[name] || []).forEach((cb) => cb(ev));
  return {
    addListener: async (name, cb) => { (listeners[name] ||= []).push(cb); return { remove() {} }; },
    tlsConnect: ({ host, port, certPem, keyPem }) => new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, cert: certPem, key: keyPem, rejectUnauthorized: false }, () => {
        const id = next++;
        conns.set(id, s);
        s.on('data', (d) => fire('tlsData', { id, data: d.toString('base64') }));
        s.on('close', () => fire('tlsClose', { id }));
        resolve({ id, peerCert: s.getPeerCertificate().raw.toString('base64') });
      });
      s.once('error', reject);
    }),
    tlsWrite: async ({ id, data }) => { conns.get(id).write(Buffer.from(data, 'base64')); },
    tlsClose: async ({ id }) => { conns.get(id)?.destroy(); },
    ssdpSearch: async () => ({ responses: [] }),
    mdnsDiscover: async () => ({ services: [] }),
    keepAwake: async () => {},
  };
}

function loadApp(plugin) {
  const store = new Map();
  const window = {
    Capacitor: { registerPlugin: () => plugin },
    forge, protobuf, TV_PROTOS,
  };
  const ctx = vm.createContext({
    window, fetch, crypto: globalThis.crypto, btoa, atob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, console, Uint8Array, TextEncoder,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  });
  for (const f of ['native/drivers.js', 'native/backend.js']) vm.runInContext(fs.readFileSync(path.join(root, 'public', f), 'utf8'), ctx, { filename: f });
  return window.NativeBackend;
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};

test('APK backend pairs with and controls an Android TV (Remote v2)', async (t) => {
  const tv = fakeAndroidTv();
  const pairingPort = await listen(tv.pairing);
  const remotePort = await listen(tv.remote);
  t.after(() => { tv.pairing.close(); tv.remote.close(); });

  // The drivers use the fixed ports 6467/6466; redirect them to the fake TV.
  const plugin = mockPlugin();
  const realConnect = plugin.tlsConnect;
  plugin.tlsConnect = (o) => realConnect({ ...o, port: o.port === 6467 ? pairingPort : remotePort });

  const be = loadApp(plugin);
  const events = [];
  be.onEvent((e) => events.push(e));

  const dev = await be.request('POST', '/devices', { host: '127.0.0.1', type: 'androidtv', name: 'Bravia' });
  const c = await be.request('POST', `/devices/${dev.id}/connect`, {});
  assert.equal(c.status, 'pairing');
  await until(() => events.find((e) => e.type === 'pairing'));
  assert.ok(tv.code, 'TV generated a code');

  await assert.rejects(be.request('POST', `/devices/${dev.id}/pair`, { code: '000000' }), /Wrong code|6 characters/);
  await be.request('POST', `/devices/${dev.id}/pair`, { code: tv.code });
  await until(() => events.find((e) => e.type === 'paired'));
  assert.equal(tv.configured, true, 'remote session configured');
  await until(() => events.find((e) => e.type === 'state' && e.payload.volume === 24));
  await until(() => tv.pong === 7);

  await be.request('POST', `/devices/${dev.id}/key`, { key: 'vol_up' });
  await be.request('POST', `/devices/${dev.id}/key`, { key: 'ok' });
  await be.request('POST', `/devices/${dev.id}/launch`, { id: 'YouTube' });
  await until(() => tv.keys.length === 2 && tv.links.length === 1);
  assert.deepEqual(tv.keys, [KeyEnum.KEYCODE_VOLUME_UP, KeyEnum.KEYCODE_DPAD_CENTER]);
  assert.deepEqual(tv.links, ['https://www.youtube.com']);

  const list = await be.request('GET', '/devices');
  assert.equal(list[0].paired, true, 'pairing persisted');

  // A fresh app start reuses the saved certificate: no pairing prompt.
  const conn2 = await be.request('POST', `/devices/${dev.id}/connect`, {});
  assert.equal(conn2.status, 'connected');
  await be.request('DELETE', `/devices/${dev.id}`);
});

test('APK backend drives Sony BRAVIA over HTTP and rejects LG/Samsung', async (t) => {
  const seen = [];
  const sony = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: b, psk: req.headers['x-auth-psk'] });
      const json = (result) => res.end(JSON.stringify({ result, id: 1 }));
      if (req.url === '/sony/system') return json(JSON.parse(b).method === 'getPowerStatus' ? [{ status: 'active' }] : [{}, []]);
      if (req.url === '/sony/audio') return json([[{ target: 'speaker', volume: 11, maxVolume: 100, mute: false }]]);
      if (req.url === '/sony/ircc') return res.end('<ok/>');
      if (req.url === '/sony/appControl') return json([]);
      res.writeHead(404); res.end();
    });
  });
  const port = await listen(sony);
  t.after(() => sony.close());

  const be = loadApp(mockPlugin());
  await assert.rejects(be.request('POST', '/devices', { host: '1.2.3.4', type: 'lg' }), /PC hub/);
  const dev = await be.request('POST', '/devices', { host: '127.0.0.1', port, type: 'sony', psk: '4321' });
  assert.equal(dev.psk, '••••');
  const c = await be.request('POST', `/devices/${dev.id}/connect`, {});
  assert.equal(c.status, 'connected');
  await be.request('POST', `/devices/${dev.id}/key`, { key: 'home' });
  const ircc = seen.find((s) => s.url === '/sony/ircc');
  assert.match(ircc.body, /AAAAAQAAAAEAAABgAw==/);
  assert.equal(ircc.psk, '4321');
  await be.request('POST', `/devices/${dev.id}/text`, { text: 'hi' });
  assert.ok(seen.some((s) => s.url === '/sony/appControl' && /setTextForm/.test(s.body)));
  await be.request('DELETE', `/devices/${dev.id}`);
});
