'use strict';
// End-to-end test of the hub against a fake Sony BRAVIA (REST + IRCC + DLNA)
// and a fake Roku, so the protocol code paths run without real hardware.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REMOTETV_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'remotetv-'));
process.env.HTTPS_PORT = '0';

const calls = [];
function fakeSony() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, psk: req.headers['x-auth-psk'], soap: req.headers.soapaction, body });
      if (req.headers['x-auth-psk'] !== '1234' && req.url.startsWith('/sony')) { res.writeHead(403); return res.end(); }
      const json = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result, id: 1 })); };
      if (req.url === '/sony/system') {
        const m = JSON.parse(body).method;
        if (m === 'getRemoteControllerInfo') return json([{ bundled: true, type: 'IR_REMOTE_BUNDLE_TYPE_AEP_N' }, [{ name: 'Up', value: 'TEST-UP==' }]]);
        if (m === 'getPowerStatus') return json([{ status: 'active' }]);
      }
      if (req.url === '/sony/audio') {
        const m = JSON.parse(body).method;
        if (m === 'getVolumeInformation') return json([[{ target: 'speaker', volume: 24, mute: false, maxVolume: 100 }]]);
        return json([0]);
      }
      if (req.url === '/sony/avContent') return json([{ title: 'HDMI 1' }]);
      if (req.url === '/sony/appControl') {
        const m = JSON.parse(body).method;
        if (m === 'getApplicationList') return json([[{ title: 'YouTube', uri: 'com.sony.dtv.youtube' }, { title: 'Netflix', uri: 'com.sony.dtv.netflix' }]]);
        return json([]);
      }
      if (req.url === '/sony/ircc') return res.end('<ok/>');
      if (req.url === '/dmr.xml') {
        return res.end(`<root><device><friendlyName>KD-55X7500F</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport</controlURL></service></serviceList></device></root>`);
      }
      if (req.url === '/upnp/control/AVTransport') {
        if (/GetTransportInfo/.test(req.headers.soapaction)) return res.end('<CurrentTransportState>PLAYING</CurrentTransportState>');
        if (/GetPositionInfo/.test(req.headers.soapaction)) return res.end('<RelTime>0:00:05</RelTime><TrackDuration>0:01:00</TrackDuration>');
        return res.end('<ok/>');
      }
      if (req.url.startsWith('/dial/YouTube')) { res.writeHead(201); return res.end(); }
      res.writeHead(404); res.end();
    });
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('hub drives a Sony BRAVIA end to end', async (t) => {
  const tv = fakeSony();
  const tvPort = await listen(tv);
  const { app } = require('../server/index.js');
  const hub = http.createServer(app);
  const hubPort = await listen(hub);
  t.after(() => { tv.close(); hub.close(); });

  const api = async (p, body, method) => {
    const r = await fetch(`http://127.0.0.1:${hubPort}/api${p}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };

  const info = await api('/info');
  assert.ok(info.data.keys.includes('vol_up'));

  // Wrong PSK -> clear error
  const bad = await api('/devices', { host: '127.0.0.1', port: tvPort, type: 'sony', name: 'Bad', psk: '0000' });
  const badConn = await api(`/devices/${bad.data.id}/connect`, {});
  assert.equal(badConn.status, 502);
  assert.match(badConn.data.error, /Pre-Shared Key/);
  assert.equal(bad.data.psk, '••••', 'PSK must not be returned to clients');

  const add = await api('/devices', {
    host: '127.0.0.1', port: tvPort, type: 'sony', name: 'Bravia', psk: '1234',
    dlna: `http://127.0.0.1:${tvPort}/dmr.xml`, dialUrl: `http://127.0.0.1:${tvPort}/dial`,
  });
  const id = add.data.id;
  assert.equal(add.data.id, bad.data.id, 'same host+type updates the saved TV');

  const conn = await api(`/devices/${id}/connect`, {});
  assert.equal(conn.status, 200, JSON.stringify(conn.data));
  assert.equal(conn.data.status, 'connected');
  assert.equal(conn.data.state.volume, 24);

  // Key uses the code learned from getRemoteControllerInfo
  calls.length = 0;
  assert.equal((await api(`/devices/${id}/key`, { key: 'up' })).status, 200);
  const ircc = calls.find((c) => c.url === '/sony/ircc');
  assert.match(ircc.body, /TEST-UP==/);
  assert.match(ircc.soap, /X_SendIRCC/);
  assert.equal(ircc.psk, '1234');

  // Fallback code for a key the TV did not list
  calls.length = 0;
  await api(`/devices/${id}/key`, { key: 'home' });
  assert.match(calls.find((c) => c.url === '/sony/ircc').body, /AAAAAQAAAAEAAABgAw==/);

  assert.equal((await api(`/devices/${id}/key`, { key: 'nope' })).status, 502);

  // Text, volume, apps, launch by friendly name
  assert.equal((await api(`/devices/${id}/text`, { text: 'hello' })).status, 200);
  assert.equal((await api(`/devices/${id}/volume`, { level: 30 })).status, 200);
  const apps = await api(`/devices/${id}/apps`);
  assert.deepEqual(apps.data.map((a) => a.name), ['YouTube', 'Netflix']);
  calls.length = 0;
  await api(`/devices/${id}/launch`, { id: 'netflix' });
  assert.match(calls.find((c) => c.url === '/sony/appControl').body, /com\.sony\.dtv\.netflix/);

  // Cast: DLNA URL playback, status, controls, YouTube via DIAL
  calls.length = 0;
  const cu = await api(`/devices/${id}/cast/url`, { url: 'http://example.com/a.mp4' });
  assert.equal(cu.status, 200, JSON.stringify(cu.data));
  const avt = calls.filter((c) => c.url === '/upnp/control/AVTransport').map((c) => c.soap);
  assert.deepEqual(avt.map((s) => s.split('#')[1]), ['Stop"', 'SetAVTransportURI"', 'Play"']);
  const st = await api(`/devices/${id}/cast/status`);
  assert.equal(st.data.state, 'PLAYING');
  assert.equal((await api(`/devices/${id}/cast/control`, { action: 'pause' })).status, 200);

  calls.length = 0;
  const yt = await api(`/devices/${id}/cast/youtube`, { url: 'https://youtube.com/shorts/dQw4w9WgXcQ' });
  assert.equal(yt.status, 200, JSON.stringify(yt.data));
  assert.equal(calls.find((c) => c.url === '/dial/YouTube').body, 'v=dQw4w9WgXcQ');

  // Upload a photo: streamed to disk, served at /media, URL pushed to the TV
  calls.length = 0;
  const up = await fetch(`http://127.0.0.1:${hubPort}/api/devices/${id}/cast/upload`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-filename': 'pic.jpg' }, body: Buffer.from('JPEGDATA'),
  });
  const upData = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upData));
  const set = calls.find((c) => /SetAVTransportURI/.test(c.soap || ''));
  assert.match(set.body, /image\/jpeg/);
  assert.match(set.body, /object\.item\.imageItem\.photo/);
  const mediaPath = new URL(upData.url).pathname;
  const served = await fetch(`http://127.0.0.1:${hubPort}${mediaPath}`);
  assert.equal(await served.text(), 'JPEGDATA');
  assert.equal(served.headers.get('transfermode.dlna.org'), 'Streaming');

  // Macro
  assert.equal((await api(`/devices/${id}/macro`, { steps: [{ key: 'home', delay: 1 }, { app: 'YouTube', delay: 1 }] })).status, 200);

  // Delete
  assert.equal((await api(`/devices/${id}`, null, 'DELETE')).status, 200);
  assert.equal((await api('/devices')).data.length, 0);
});

test('youtube id parsing', () => {
  const { youtubeId } = require('../server/cast');
  for (const u of ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ']) {
    assert.equal(youtubeId(u), 'dQw4w9WgXcQ');
  }
  assert.throws(() => youtubeId('https://example.com'));
});

test('sony fallback IRCC table matches Sony published codes', () => {
  const { FALLBACK } = require('../server/drivers/sony');
  assert.equal(FALLBACK.up, 'AAAAAQAAAAEAAAB0Aw==');
  assert.equal(FALLBACK.ok, 'AAAAAQAAAAEAAABlAw==');
  assert.equal(FALLBACK.back, 'AAAAAgAAAJcAAAAjAw==');
  assert.equal(FALLBACK.vol_up, 'AAAAAQAAAAEAAAASAw==');
  assert.equal(FALLBACK['1'], 'AAAAAQAAAAEAAAAAAw==');
  assert.equal(FALLBACK['0'], 'AAAAAQAAAAEAAAAJAw==');
});
