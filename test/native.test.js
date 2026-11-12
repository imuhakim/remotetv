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
    tcpConnect: ({ host, port }) => new Promise((resolve, reject) => {
      const s = require('net').connect({ host, port }, () => {
        const id = next++;
        conns.set(id, s);
        s.on('data', (d) => fire('tlsData', { id, data: d.toString('base64') }));
        s.on('close', () => fire('tlsClose', { id }));
        resolve({ id });
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
    setInterval, clearInterval, console, Uint8Array, TextEncoder, TextDecoder, Date,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  });
  for (const f of ['native/drivers.js', 'native/adb.js', 'native/backend.js']) vm.runInContext(fs.readFileSync(path.join(root, 'public', f), 'utf8'), ctx, { filename: f });
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
  // "Open on the TV": YouTube links open the video, other links open as app links.
  assert.equal((await be.request('POST', `/devices/${dev.id}/open`, { url: 'https://youtu.be/dQw4w9WgXcQ' })).via, 'youtube');
  assert.equal((await be.request('POST', `/devices/${dev.id}/open`, { url: 'https://example.com/page' })).via, 'browser');
  await assert.rejects(be.request('POST', `/devices/${dev.id}/open`, { url: 'ftp://x' }), /https/);
  await until(() => tv.keys.length === 2 && tv.links.length === 3);
  assert.deepEqual(tv.keys, [KeyEnum.KEYCODE_VOLUME_UP, KeyEnum.KEYCODE_DPAD_CENTER]);
  assert.deepEqual(tv.links, ['https://www.youtube.com', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://example.com/page']);

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
  await be.request('POST', `/devices/${dev.id}/open`, { url: 'https://example.com/a?b=1' });
  const opened = seen.find((s) => s.url === '/sony/appControl' && /setActiveApp/.test(s.body));
  assert.equal(JSON.parse(opened.body).params[0].uri, 'localapp://webappruntime?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1');
  await be.request('DELETE', `/devices/${dev.id}`);
});

test('APK infra-red mode sends Sony SIRC patterns through the phone IR emitter', async () => {
  const sent = [];
  const plugin = { ...mockPlugin(), irInfo: async () => ({ hasIr: true }), irTransmit: async (o) => { sent.push(o); } };
  const be = loadApp(plugin);
  assert.equal((await be.request('GET', '/info')).hasIr, true);
  const dev = await be.request('POST', '/devices', { type: 'sony_ir' });
  assert.equal(dev.host, 'infra-red-sony');
  assert.equal((await be.request('POST', `/devices/${dev.id}/connect`, {})).status, 'connected');

  // Decode marks after the 2.4 ms header back into bits (LSB first).
  const decode = (p) => {
    assert.equal(p[0], 2400);
    const bits = [];
    for (let i = 2; i < p.length && p[i] !== 2400; i += 2) bits.push(p[i] === 1200 ? 1 : 0);
    const num = (from, n) => bits.slice(from, from + n).reduce((a, b, i) => a | (b << i), 0);
    return { bits: bits.length, cmd: num(0, 7), dev: num(7, bits.length - 7) };
  };
  await be.request('POST', `/devices/${dev.id}/key`, { key: 'vol_up' });
  await be.request('POST', `/devices/${dev.id}/key`, { key: 'power' });
  await be.request('POST', `/devices/${dev.id}/key`, { key: 'back' });
  assert.deepEqual(decode(sent[0].pattern), { bits: 12, cmd: 0x12, dev: 1 });
  assert.deepEqual(decode(sent[1].pattern), { bits: 12, cmd: 0x15, dev: 1 });
  assert.deepEqual(decode(sent[2].pattern), { bits: 15, cmd: 0x23, dev: 0x97 });
  assert.equal(sent[0].frequency, 40000);
  // 3 frames of 45 ms each, the last one without its trailing gap.
  const total = sent[0].pattern.reduce((a, x) => a + x, 0);
  assert.ok(total > 90000 && total < 135000, `pattern length ${total}`);
  assert.equal(sent[0].pattern.length % 2, 1, 'starts and ends with a mark');

  const noIr = loadApp({ ...mockPlugin(), irInfo: async () => ({ hasIr: false }) });
  const d2 = await noIr.request('POST', '/devices', { type: 'sony_ir' });
  await assert.rejects(noIr.request('POST', `/devices/${d2.id}/connect`, {}), /no infra-red/);
});

// ------------------------------------------------------------ fake ADB TV
function fakeAdbTv() {
  const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257 };
  const tv = { allowed: [], prompts: 0, commands: [] };
  // Android RSAPublicKey struct -> Node public key (also checks n0inv and e).
  const parseKey = (b64) => {
    const raw = Buffer.from(b64, 'base64');
    const words = raw.readUInt32LE(0);
    const n = Buffer.alloc(words * 4);
    for (let i = 0; i < words * 4; i++) n[words * 4 - 1 - i] = raw[8 + i];
    const n0 = BigInt(raw.readUInt32LE(8));
    assert.equal((n0 * BigInt(raw.readUInt32LE(4))) % 2n ** 32n, 2n ** 32n - 1n, 'n0inv');
    assert.equal(raw.readUInt32LE(8 + words * 8), 65537);
    return crypto.createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: 'AQAB' }, format: 'jwk' });
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'),
    Buffer.from([0, 0, 7, 128, 0, 0, 4, 56]), crypto.randomBytes(300000)]);
  tv.server = require('net').createServer((sock) => {
    let buf = Buffer.alloc(0);
    let token;
    const send = (cmd, a0, a1, data = Buffer.alloc(0)) => {
      const h = Buffer.alloc(24);
      h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8); h.writeUInt32LE(data.length, 12);
      h.writeUInt32LE(0, 16); h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
      sock.write(Buffer.concat([h, data]));
    };
    const authToken = () => { token = crypto.randomBytes(20); send(CMD.AUTH, 1, 0, token); };
    const reply = (local, out) => {
      send(CMD.OKAY, 99, local);
      for (let i = 0; i < out.length; i += 4096) send(CMD.WRTE, 99, local, out.subarray(i, i + 4096));
      send(CMD.CLSE, 99, local);
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 24) {
        const len = buf.readUInt32LE(12);
        if (buf.length < 24 + len) return;
        const cmd = buf.readUInt32LE(0);
        const a0 = buf.readUInt32LE(4);
        const data = buf.subarray(24, 24 + len);
        let sum = 0;
        for (const b of data) sum = (sum + b) >>> 0;
        assert.equal(buf.readUInt32LE(16), sum, 'checksum');
        assert.equal(buf.readUInt32LE(20), (cmd ^ 0xffffffff) >>> 0, 'magic');
        buf = buf.subarray(24 + len);
        if (cmd === CMD.CNXN) authToken();
        else if (cmd === CMD.AUTH && a0 === 2) {
          const ok = tv.allowed.some((k) => {
            try { return crypto.publicDecrypt({ key: k, padding: crypto.constants.RSA_PKCS1_PADDING }, data).subarray(-20).equals(token); } catch { return false; }
          });
          if (ok) send(CMD.CNXN, 0x01000001, 4096, Buffer.from('device::ro.product.model=FakeBravia;'));
          else authToken();
        } else if (cmd === CMD.AUTH && a0 === 3) {
          tv.prompts++;
          tv.allowed.push(parseKey(data.toString('utf8').split(' ')[0])); // the user taps "Always allow"
          send(CMD.CNXN, 0x01000001, 4096, Buffer.from('device::ro.product.model=FakeBravia;'));
        } else if (cmd === CMD.OPEN) {
          const service = data.toString('utf8').replace(/\0$/, '');
          tv.commands.push(service);
          const c = service.replace(/^exec:/, '');
          let out = '';
          if (c === 'screencap -p') { reply(a0, png); continue; }
          if (c.startsWith('cmd package query-activities')) out = 'packageName=com.google.android.youtube.tv\n  packageName=com.netflix.ninja\n';
          else if (c === 'pm list packages -3') out = 'package:com.netflix.ninja\n';
          else if (c.includes('getprop ro.product.model')) {
            out = 'model=KD-55X7500F\nbrand=Sony\nandroid=9\nuptime=3600\nMemTotal:        1918000 kB\nMemAvailable:     712000 kB\ntemp=48000\n'
              + '/dev/block/dm-0   9.6G  4.2G  5.4G  44% /data\n  mResumedActivity: ActivityRecord{1 u0 com.google.android.youtube.tv/.MainActivity t1}\n';
          }
          reply(a0, Buffer.from(out));
        }
      }
    });
  });
  return tv;
}

test('APK ADB mode: authorises once, then screenshots, taps, apps and TV info', async (t) => {
  const tv = fakeAdbTv();
  const port = await listen(tv.server);
  t.after(() => tv.server.close());
  const be = loadApp(mockPlugin());
  const events = [];
  be.onEvent((e) => events.push(e));
  assert.equal((await be.request('GET', '/info')).adb, true);
  const dev = await be.request('POST', '/devices', { host: '127.0.0.1', type: 'androidtv', name: 'Bravia' });
  await be.request('PATCH', `/devices/${dev.id}`, { adbPort: port }); // point ADB at the fake TV

  const c = await be.request('POST', `/devices/${dev.id}/adb/connect`, {});
  assert.equal(c.connected, true);
  assert.match(c.banner, /FakeBravia/);
  assert.equal(tv.prompts, 1, 'TV showed the "Allow debugging" prompt once');
  assert.ok(events.some((e) => e.type === 'adbPrompt'));

  const shot = await be.request('GET', `/devices/${dev.id}/adb/screen`);
  assert.deepEqual([shot.w, shot.h], [1920, 1080]);
  assert.ok(Buffer.from(shot.png, 'base64').length > 300000, 'large screenshot reassembled from many chunks');

  await be.request('POST', `/devices/${dev.id}/adb/tap`, { x: 960.4, y: 540 });
  await be.request('POST', `/devices/${dev.id}/adb/app`, { id: 'com.netflix.ninja', action: 'stop' });
  await assert.rejects(be.request('POST', `/devices/${dev.id}/adb/app`, { id: 'x; reboot', action: 'stop' }), /Bad package/);
  const apps = await be.request('GET', `/devices/${dev.id}/adb/apps`);
  assert.deepEqual(apps, [{ id: 'com.google.android.youtube.tv', user: false }, { id: 'com.netflix.ninja', user: true }]);
  const info = await be.request('GET', `/devices/${dev.id}/adb/info`);
  assert.equal(info.model, 'KD-55X7500F');
  assert.equal(info.memTotalMb, 1873);
  assert.equal(info.tempC, 48);
  assert.equal(info.topApp, 'com.google.android.youtube.tv');
  assert.deepEqual(info.storage, { size: '9.6G', used: '4.2G', free: '5.4G' });
  assert.ok(tv.commands.includes('exec:input tap 960 540'));
  assert.ok(tv.commands.includes('exec:am force-stop com.netflix.ninja'));

  // Reconnecting reuses the allowed key: no second prompt on the TV.
  await be.request('POST', `/devices/${dev.id}/adb/disconnect`, {});
  await be.request('POST', `/devices/${dev.id}/adb/connect`, {});
  assert.equal(tv.prompts, 1);
  await be.request('DELETE', `/devices/${dev.id}`);
});

test('APK universal IR: Samsung32 and LG NEC patterns decode to the right codes', async () => {
  const sent = [];
  const be = loadApp({ ...mockPlugin(), irInfo: async () => ({ hasIr: true }), irTransmit: async (o) => { sent.push(o); } });
  // 32-bit decoder: header, then 560 us marks with 1690 (1) / 560 (0) spaces, LSB first.
  const decode32 = (p) => {
    const bytes = [];
    for (let b = 0; b < 4; b++) {
      let v = 0;
      for (let i = 0; i < 8; i++) v |= (p[2 + (b * 8 + i) * 2 + 1] === 1690 ? 1 : 0) << i;
      bytes.push(v);
    }
    return { header: [p[0], p[1]], bytes, len: p.length };
  };
  const sam = await be.request('POST', '/devices', { type: 'ir', brand: 'samsung' });
  const lg = await be.request('POST', '/devices', { type: 'ir', brand: 'lg' });
  assert.equal(sam.name, 'Samsung TV (infra-red)');
  assert.equal(lg.name, 'LG TV (infra-red)');
  await be.request('POST', `/devices/${sam.id}/connect`, {});
  await be.request('POST', `/devices/${lg.id}/connect`, {});
  await be.request('POST', `/devices/${sam.id}/key`, { key: 'power' });
  await be.request('POST', `/devices/${sam.id}/key`, { key: 'vol_up' });
  await be.request('POST', `/devices/${lg.id}/key`, { key: 'power' });
  await be.request('POST', `/devices/${lg.id}/key`, { key: '5' });
  assert.deepEqual(decode32(sent[0].pattern), { header: [4500, 4500], bytes: [0x07, 0x07, 0x02, 0xfd], len: 67 });
  assert.deepEqual(decode32(sent[1].pattern).bytes, [0x07, 0x07, 0x07, 0xf8]);
  assert.deepEqual(decode32(sent[2].pattern), { header: [9000, 4500], bytes: [0x04, 0xfb, 0x08, 0xf7], len: 67 });
  assert.deepEqual(decode32(sent[3].pattern).bytes, [0x04, 0xfb, 0x15, 0xea]);
  assert.deepEqual(sent.map((s) => s.frequency), [38000, 38000, 38000, 38000]);
  await assert.rejects(be.request('POST', `/devices/${lg.id}/key`, { key: 'search' }), /not available over infra-red for LG/);
});

test('APK shop TV: a temporary TV is forgotten after 12 hours', async () => {
  const be = loadApp(mockPlugin());
  const keep = await be.request('POST', '/devices', { host: '10.0.0.2', type: 'roku', name: 'Home' });
  const shop = await be.request('POST', '/devices', { host: '10.0.0.9', type: 'roku', name: 'Kedai', temp: true });
  assert.equal(shop.temp, true);
  assert.ok(shop.expiresAt > Date.now() + 11.9 * 3600e3);
  assert.equal((await be.request('GET', '/devices')).length, 2);
  const realNow = Date.now;
  Date.now = () => realNow() + 12.1 * 3600e3;
  try {
    const left = await be.request('GET', '/devices');
    assert.deepEqual(left.map((d) => d.id), [keep.id]);
  } finally { Date.now = realNow; }
});
