'use strict';
/* In-app replacement for the Node hub's REST API, used by the Android APK.
 * app.js calls NativeBackend.request(method, path, body) instead of fetch('/api/...'). */
(function () {
  const { RemoteTv, req, xmlTag, drivers, cast } = window.NativeTv;
  const KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'apps', 'vol_up', 'vol_down', 'mute', 'ch_up', 'ch_down',
    'power', 'power_off', 'input', 'info', 'guide', 'settings', 'search', 'play', 'pause', 'play_pause', 'stop', 'rewind', 'forward',
    'prev', 'next', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'red', 'green', 'yellow', 'blue'];

  // ---------------------------------------------------------------- store
  const KEY = 'remotetv.native.store';
  let data = { devices: [], lastDeviceId: null };
  try { data = { ...data, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { /* first run */ }
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));
  const getDev = (id) => data.devices.find((d) => d.id === id);
  const publicView = (d) => ({ ...d, psk: d.psk ? '••••' : undefined });

  // ------------------------------------------------------------- sessions
  const sessions = new Map();
  let listener = () => {};
  const emitFor = (device) => (type, payload) => {
    if (type === 'persist') { Object.assign(device, payload); save(); return; }
    const s = sessions.get(device.id);
    if (type === 'state' && s) s.state = { ...s.state, ...payload };
    if (type === 'paired' && s) s.status = 'connected';
    listener({ type, deviceId: device.id, payload });
  };

  async function connect(device) {
    sessions.get(device.id)?.driver.close();
    const Driver = drivers[device.type];
    if (!Driver) throw err(400, `${device.type} is only available with the PC hub version`);
    const driver = new Driver(device, emitFor(device));
    const s = { driver, state: {}, status: 'connecting' };
    sessions.set(device.id, s);
    try {
      const r = await driver.connect();
      s.status = r === 'pairing' ? 'pairing' : 'connected';
    } catch (e) { s.status = 'error'; throw e; }
    data.lastDeviceId = device.id;
    save();
    return s;
  }

  async function session(id) {
    const d = getDev(id);
    if (!d) throw err(404, 'Unknown device');
    let s = sessions.get(id);
    if (!s || s.status === 'error') s = await connect(d);
    if (s.status === 'pairing') throw err(409, 'Finish pairing first');
    return { device: d, driver: s.driver };
  }

  function err(status, message) { return Object.assign(new Error(message), { status }); }

  // ------------------------------------------------------------ discovery
  const TARGETS = ['urn:schemas-sony-com:service:ScalarWebAPI:1', 'roku:ecp', 'urn:dial-multiscreen-org:service:dial:1', 'urn:schemas-upnp-org:device:MediaRenderer:1'];
  async function discover(timeout) {
    const [ssdp, mdns] = await Promise.all([
      RemoteTv.ssdpSearch({ targets: TARGETS, timeoutMs: timeout }).catch(() => ({ responses: [] })),
      RemoteTv.mdnsDiscover({ type: '_androidtvremote2._tcp', timeoutMs: timeout }).catch(() => ({ services: [] })),
    ]);
    const locs = new Map();
    for (const r of ssdp.responses) {
      const loc = /^location:\s*(.+)$/im.exec(r.text)?.[1]?.trim();
      const st = /^st:\s*(.+)$/im.exec(r.text)?.[1]?.trim() || '';
      if (loc && (!locs.has(loc) || /sony|roku/.test(st))) locs.set(loc, st);
    }
    const described = await Promise.all([...locs].map(async ([location, st]) => {
      const u = new URL(location);
      const out = { host: u.hostname, st };
      try {
        const r = await req(location, { timeout: 2500 });
        out.name = xmlTag(r.text, 'friendlyName');
        out.manufacturer = xmlTag(r.text, 'manufacturer') || '';
        out.modelName = xmlTag(r.text, 'modelName') || '';
        out.dialUrl = r.headers.get('application-url');
        if (/AVTransport/i.test(r.text)) out.dlna = location;
      } catch { /* ignore */ }
      const s = `${st} ${out.manufacturer} ${out.modelName}`.toLowerCase();
      out.type = s.includes('roku') ? 'roku' : s.includes('sony') ? 'sony' : 'dlna';
      if (out.type === 'roku') out.port = Number(u.port) || 8060;
      return out;
    }));
    const byHost = new Map();
    const add = (d) => {
      const cur = byHost.get(d.host) || { host: d.host, name: d.name, protocols: [], dlna: null, dialUrl: null };
      cur.name = cur.name || d.name;
      cur.modelName = cur.modelName || d.modelName;
      if (d.type !== 'dlna' && !cur.protocols.includes(d.type)) cur.protocols.push(d.type);
      if (d.dlna) cur.dlna = d.dlna;
      if (d.dialUrl) cur.dialUrl = d.dialUrl;
      if (d.port) cur.port = d.port;
      byHost.set(d.host, cur);
    };
    described.forEach(add);
    mdns.services.forEach((m) => add({ host: m.host, name: m.name, type: 'androidtv' }));
    return [...byHost.values()].filter((d) => d.protocols.length || d.dlna);
  }

  function dlnaOf(id) {
    const d = getDev(id);
    if (!d) throw err(404, 'Unknown device');
    if (!d.dlna) throw err(400, 'No DLNA player known for this TV. Use "Scan network" to add it so casting is detected.');
    return d;
  }

  // ---------------------------------------------------------------- routes
  const routes = [
    ['GET', /^\/info$/, async () => {
      const ir = await RemoteTv.irInfo().catch(() => ({ hasIr: false }));
      return { keys: KEYS, hub: 'This phone (no hub needed)', native: true, hasIr: !!ir.hasIr, lastDeviceId: data.lastDeviceId };
    }],
    ['GET', /^\/discover$/, (b, m, q) => discover(Number(q.get('timeout')) || 3500)],
    ['GET', /^\/devices$/, () => data.devices.map((d) => ({ ...publicView(d), status: sessions.get(d.id)?.status || 'idle', state: sessions.get(d.id)?.state || {} }))],
    ['POST', /^\/devices$/, (b) => {
      if (b?.type === 'sony_ir') b = { name: 'Sony TV (infra-red)', ...b, host: 'infra-red' };
      if (!b?.host || !b.type) throw err(400, 'host and type are required');
      if (!drivers[b.type]) throw err(400, `${b.type} TVs need the PC hub version for now`);
      const fields = ['host', 'type', 'name', 'psk', 'mac', 'dlna', 'dialUrl', 'port'];
      const clean = Object.fromEntries(fields.filter((f) => b[f] !== undefined && b[f] !== null).map((f) => [f, b[f]]));
      let d = data.devices.find((x) => x.host === b.host && x.type === b.type);
      if (d) Object.assign(d, clean);
      else { d = { id: Math.random().toString(36).slice(2, 10), addedAt: Date.now(), ...clean }; data.devices.push(d); }
      d.name = d.name || `${d.type} ${d.host}`;
      save();
      return publicView(d);
    }],
    ['PATCH', /^\/devices\/(\w+)$/, (b, m) => {
      const d = getDev(m[1]);
      if (!d) throw err(404, 'Unknown device');
      for (const k of ['name', 'psk', 'mac', 'dlna', 'dialUrl']) if (b[k] !== undefined) d[k] = b[k];
      save();
      return publicView(d);
    }],
    ['DELETE', /^\/devices\/(\w+)$/, (b, m) => {
      sessions.get(m[1])?.driver.close();
      sessions.delete(m[1]);
      data.devices = data.devices.filter((d) => d.id !== m[1]);
      save();
      return { ok: true };
    }],
    ['POST', /^\/devices\/(\w+)\/connect$/, async (b, m) => {
      const d = getDev(m[1]);
      if (!d) throw err(404, 'Unknown device');
      const s = await connect(d);
      return { status: s.status, state: s.state };
    }],
    ['POST', /^\/devices\/(\w+)\/pair$/, async (b, m) => {
      const s = sessions.get(m[1]);
      if (!s?.driver.pair) throw err(400, 'This TV does not use a pairing code');
      await s.driver.pair(b.code);
      return { ok: true };
    }],
    ['POST', /^\/devices\/(\w+)\/key$/, async (b, m) => { const { driver } = await session(m[1]); await driver.sendKey(String(b.key), b.mode); }],
    ['POST', /^\/devices\/(\w+)\/text$/, async (b, m) => {
      const { driver } = await session(m[1]);
      if (!driver.sendText) throw err(501, 'Typing is not supported over this protocol. On Sony, add the TV as "Sony BRAVIA (IP control)".');
      await driver.sendText(String(b.text || ''));
    }],
    ['POST', /^\/devices\/(\w+)\/volume$/, async (b, m) => {
      const { driver } = await session(m[1]);
      if (!driver.setVolume) throw err(501, 'Use volume + / −');
      await driver.setVolume(Number(b.level));
    }],
    ['GET', /^\/devices\/(\w+)\/apps$/, async (b, m) => { const { driver } = await session(m[1]); return driver.listApps ? driver.listApps() : []; }],
    ['POST', /^\/devices\/(\w+)\/launch$/, async (b, m) => { const { driver } = await session(m[1]); await driver.launchApp(String(b.id)); }],
    ['GET', /^\/devices\/(\w+)\/inputs$/, async (b, m) => { const { driver } = await session(m[1]); return driver.listInputs ? driver.listInputs() : []; }],
    ['POST', /^\/devices\/(\w+)\/input$/, async (b, m) => {
      const { driver } = await session(m[1]);
      if (driver.setInput) await driver.setInput(b.id); else await driver.sendKey('input');
    }],
    ['POST', /^\/devices\/(\w+)\/wake$/, async (b, m) => {
      const d = getDev(m[1]);
      if (!d?.mac) throw err(400, 'Save the TV MAC address (Settings › Edit) to use Wake-on-LAN');
      await RemoteTv.wakeOnLan({ mac: d.mac });
    }],
    ['POST', /^\/devices\/(\w+)\/macro$/, async (b, m) => {
      const { driver } = await session(m[1]);
      for (const s of (b.steps || []).slice(0, 50)) {
        if (s.key) await driver.sendKey(s.key);
        else if (s.text && driver.sendText) await driver.sendText(s.text);
        else if (s.app) await driver.launchApp(s.app);
        await new Promise((r) => setTimeout(r, Math.min(Number(s.delay) || 250, 10000)));
      }
    }],
    ['POST', /^\/devices\/(\w+)\/cast\/pick$/, async (b, m) => {
      const d = dlnaOf(m[1]);
      const f = await RemoteTv.pickMedia({ mime: b.mime || '*/*', tvHost: d.host });
      await cast.play(d.dlna, f.url, f.mime, f.name);
      return { name: f.name };
    }],
    ['POST', /^\/devices\/(\w+)\/cast\/url$/, async (b, m) => {
      const d = dlnaOf(m[1]);
      if (!/^https?:\/\//.test(b.url || '')) throw err(400, 'A http(s) media URL is required');
      await cast.play(d.dlna, b.url, b.mime || 'video/mp4', b.url.split('/').pop());
    }],
    ['POST', /^\/devices\/(\w+)\/cast\/youtube$/, async (b, m) => {
      const d = getDev(m[1]);
      if (!d) throw err(404, 'Unknown device');
      const v = cast.youtubeId(b.url);
      const s = sessions.get(d.id);
      if (s?.status === 'connected' && s.driver.castYouTube) return s.driver.castYouTube(v);
      if (d.dialUrl) return cast.dialYouTube(d.dialUrl, v);
      throw err(400, 'Connect to the TV first, or scan so its DIAL service is found');
    }],
    ['POST', /^\/devices\/(\w+)\/cast\/control$/, async (b, m) => { await cast.control(dlnaOf(m[1]).dlna, b.action, b.value); }],
    ['GET', /^\/devices\/(\w+)\/cast\/status$/, async (b, m) => cast.status(dlnaOf(m[1]).dlna)],
  ];

  async function request(method, path, body) {
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    for (const [verb, re, fn] of routes) {
      const m = verb === method && re.exec(p);
      if (m) {
        try { return (await fn(body || {}, m, q)) ?? { ok: true }; }
        catch (e) { throw Object.assign(new Error(e.message || String(e)), { status: e.status || 502 }); }
      }
    }
    throw err(404, `No route ${method} ${path}`);
  }

  window.NativeBackend = {
    request,
    onEvent(cb) { listener = cb; },
    keepAwake(on) { return RemoteTv.keepAwake({ on }).catch(() => {}); },
  };
})();
