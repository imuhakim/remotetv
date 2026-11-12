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
  const TEMP_MS = 30 * 24 * 3600 * 1000; // shop TVs: forgotten after 30 days without use
  function purgeExpired() {
    const now = Date.now();
    const gone = data.devices.filter((d) => d.expiresAt && d.expiresAt < now);
    if (!gone.length) return;
    for (const d of gone) { sessions.get(d.id)?.driver.close(); sessions.delete(d.id); adbs?.get(d.id)?.close(); adbs?.delete(d.id); }
    data.devices = data.devices.filter((d) => !gone.includes(d));
    if (gone.some((d) => d.id === data.lastDeviceId)) data.lastDeviceId = null;
    save();
  }
  const getDev = (id) => data.devices.find((d) => d.id === id);
  const publicView = (d) => ({ ...d, psk: d.psk ? '••••' : undefined, helperToken: undefined, helperPaired: !!d.helperToken });

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
    if (device.temp) { device.expiresAt = Date.now() + TEMP_MS; save(); } // every use restarts the 30 days
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

  // --------------------------------------------------- ADB (advanced mode)
  const adbs = new Map(); // deviceId -> connected NativeAdb.Adb
  async function adbFor(id, { fresh = false } = {}) {
    const d = getDev(id);
    if (!d) throw err(404, 'Unknown device');
    if (!window.NativeAdb) throw err(501, 'ADB is not available in this build');
    let a = adbs.get(id);
    if (a && !a.closed && !fresh) return a;
    a?.close();
    a = new window.NativeAdb.Adb(d.host, d.adbPort || 5555);
    adbs.set(id, a);
    try {
      await a.connect({
        timeoutMs: fresh ? 60000 : 10000,
        onPrompt: () => listener({ type: 'adbPrompt', deviceId: id, payload: {} }),
      });
    } catch (e) { adbs.delete(id); throw err(502, e.message); }
    if (!d.adb) { d.adb = true; save(); }
    return a;
  }
  const A = () => window.NativeAdb.features;

  // ------------------------------------------- TV Helper ("Draw on TV")
  const helpers = new Map(); // deviceId -> NativeHelper.HelperLink
  async function helperFor(id, { fresh = false } = {}) {
    const d = getDev(id);
    if (!d) throw err(404, 'Unknown device');
    if (!window.NativeHelper) throw err(501, 'Draw on TV is not available in this build');
    let h = helpers.get(id);
    if (h && !h.closed && !fresh) return h;
    h?.close();
    h = new window.NativeHelper.HelperLink(d.host, d.helperPort || window.NativeHelper.PORT);
    try { await h.open(); } catch (e) { throw err(503, e.message); }
    helpers.set(id, h);
    const r = await h.request({ t: 'hello', token: d.helperToken || '', name: 'RemoteTV phone' });
    h.paired = !!r.paired;
    h.size = { w: r.w, h: r.h };
    h.overlay = !!r.overlay;
    if (!r.paired && d.helperToken) { delete d.helperToken; save(); } // the TV forgot this phone
    return h;
  }
  const OVERLAY_OFF = 'The RemoteTV Helper on the TV is not allowed to draw over other apps yet. On the TV open RemoteTV Helper › "Allow drawing over other apps", or use Advanced (ADB) › Install TV helper, which allows it automatically.';

  function mediaMime(url) {
    const ext = url.split(/[?#]/)[0].split('.').pop().toLowerCase();
    return { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', m3u8: 'application/vnd.apple.mpegurl',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext] || null;
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
      const ir = await Promise.resolve().then(() => RemoteTv.irInfo()).catch(() => ({ hasIr: false }));
      return { keys: KEYS, hub: 'This phone (no hub needed)', native: true, adb: !!window.NativeAdb, draw: !!window.NativeHelper, hasIr: !!ir.hasIr, lastDeviceId: data.lastDeviceId };
    }],
    ['GET', /^\/discover$/, (b, m, q) => discover(Number(q.get('timeout')) || 3500)],
    ['GET', /^\/devices$/, () => (purgeExpired(), data.devices).map((d) => ({ ...publicView(d), status: sessions.get(d.id)?.status || 'idle', state: sessions.get(d.id)?.state || {} }))],
    ['POST', /^\/devices$/, (b) => {
      if (b?.type === 'sony_ir') b = { ...b, type: 'ir', brand: 'sony' };
      if (b?.type === 'ir') {
        const brand = (window.NativeTv.ir.BRANDS.includes(b.brand) ? b.brand : 'sony');
        const label = brand === 'lg' ? 'LG' : brand[0].toUpperCase() + brand.slice(1);
        b = { name: `${label} TV (infra-red)`, ...b, brand, host: `infra-red-${brand}` };
      }
      if (!b?.host || !b.type) throw err(400, 'host and type are required');
      if (!drivers[b.type]) throw err(400, `${b.type} TVs need the PC hub version for now`);
      const fields = ['host', 'type', 'name', 'psk', 'mac', 'dlna', 'dialUrl', 'port', 'brand'];
      const clean = Object.fromEntries(fields.filter((f) => b[f] !== undefined && b[f] !== null).map((f) => [f, b[f]]));
      let d = data.devices.find((x) => x.host === b.host && x.type === b.type);
      if (d) Object.assign(d, clean);
      else { d = { id: Math.random().toString(36).slice(2, 10), addedAt: Date.now(), ...clean }; data.devices.push(d); }
      d.name = d.name || `${d.type} ${d.host}`;
      if (b.temp) { d.temp = true; d.expiresAt = Date.now() + TEMP_MS; } else if (b.temp === false) { delete d.temp; delete d.expiresAt; }
      save();
      return publicView(d);
    }],
    ['PATCH', /^\/devices\/(\w+)$/, (b, m) => {
      const d = getDev(m[1]);
      if (!d) throw err(404, 'Unknown device');
      for (const k of ['name', 'psk', 'mac', 'dlna', 'dialUrl', 'adbPort', 'helperPort']) if (b[k] !== undefined) d[k] = b[k];
      save();
      return publicView(d);
    }],
    ['DELETE', /^\/devices\/(\w+)$/, (b, m) => {
      adbs.get(m[1])?.close();
      adbs.delete(m[1]);
      helpers.get(m[1])?.close();
      helpers.delete(m[1]);
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
    ['POST', /^\/devices\/(\w+)\/open$/, async (b, m) => {
      // "Open on the TV": YouTube links go to the YouTube app, media files to
      // the DLNA player, anything else to the TV's browser / app links.
      const url = String(b.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw err(400, 'Paste a link that starts with http:// or https://');
      const d = getDev(m[1]);
      if (!d) throw err(404, 'Unknown device');
      let yt = null;
      if (/youtu.?be/i.test(url)) try { yt = cast.youtubeId(url); } catch { /* not a video link */ }
      if (yt) {
        const s = sessions.get(d.id);
        if (s?.status === 'connected' && s.driver.castYouTube) { await s.driver.castYouTube(yt); return { via: 'youtube' }; }
        if (d.dialUrl) { await cast.dialYouTube(d.dialUrl, yt); return { via: 'youtube' }; }
      }
      const mime = mediaMime(url);
      if (mime && d.dlna) { await cast.play(d.dlna, url, mime, url.split('/').pop()); return { via: 'dlna' }; }
      const { driver } = await session(d.id);
      if (driver.openUrl) { await driver.openUrl(url); return { via: 'browser' }; }
      throw err(501, 'This TV cannot open links over this connection. Try the Android TV connection.');
    }],
    ['POST', /^\/devices\/(\w+)\/adb\/connect$/, async (b, m) => {
      const a = await adbFor(m[1], { fresh: true });
      return { connected: true, banner: a.banner };
    }],
    ['POST', /^\/devices\/(\w+)\/adb\/disconnect$/, (b, m) => {
      adbs.get(m[1])?.close();
      adbs.delete(m[1]);
      const d = getDev(m[1]);
      if (d) { d.adb = false; save(); }
    }],
    ['GET', /^\/devices\/(\w+)\/adb\/screen$/, async (b, m) => A().screenshot(await adbFor(m[1]))],
    ['POST', /^\/devices\/(\w+)\/adb\/tap$/, async (b, m) => { await A().tap(await adbFor(m[1]), Number(b.x), Number(b.y)); }],
    ['POST', /^\/devices\/(\w+)\/adb\/swipe$/, async (b, m) => {
      await A().swipe(await adbFor(m[1]), Number(b.x1), Number(b.y1), Number(b.x2), Number(b.y2), Number(b.ms) || 250);
    }],
    ['POST', /^\/devices\/(\w+)\/adb\/text$/, async (b, m) => { await A().text(await adbFor(m[1]), String(b.text || '')); }],
    ['GET', /^\/devices\/(\w+)\/adb\/apps$/, async (b, m) => A().apps(await adbFor(m[1]))],
    ['POST', /^\/devices\/(\w+)\/adb\/app$/, async (b, m) => {
      const a = await adbFor(m[1]);
      if (b.action === 'stop') await A().stopApp(a, String(b.id)); else await A().openApp(a, String(b.id));
    }],
    ['GET', /^\/devices\/(\w+)\/adb\/info$/, async (b, m) => A().info(await adbFor(m[1]))],
    ['POST', /^\/devices\/(\w+)\/adb\/sleep$/, async (b, m) => { await A().sleepTimer(await adbFor(m[1]), Number(b.minutes) || 0); }],
    ['GET', /^\/devices\/(\w+)\/adb\/helper$/, async (b, m) => A().helperState(await adbFor(m[1]))],
    ['POST', /^\/devices\/(\w+)\/adb\/install-helper$/, async (b, m) => {
      const a = await adbFor(m[1]);
      let asset;
      try { asset = await RemoteTv.readAsset({ path: 'tvhelper.apk' }); } catch { throw err(501, 'The TV helper is not bundled in this build of the app'); }
      const bin = atob(asset.data);
      const apk = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) apk[i] = bin.charCodeAt(i);
      return A().installHelper(a, apk);
    }],

    // Draw on TV (needs the RemoteTV Helper app on the TV)
    ['POST', /^\/devices\/(\w+)\/draw\/connect$/, async (b, m) => {
      const h = await helperFor(m[1], { fresh: true });
      if (!h.overlay) throw err(409, OVERLAY_OFF);
      return { paired: h.paired, w: h.size.w, h: h.size.h };
    }],
    ['POST', /^\/devices\/(\w+)\/draw\/pair$/, async (b, m) => {
      const h = helpers.get(m[1]);
      if (!h || h.closed) throw err(409, 'Open Draw on TV again to get a new code');
      const r = await h.request({ t: 'pair', code: String(b.code || '').replace(/\D/g, '') });
      if (!r.ok) throw err(403, r.error || 'Wrong code');
      const d = getDev(m[1]);
      d.helperToken = r.token;
      save();
      h.paired = true;
      return { paired: true };
    }],
    ['POST', /^\/devices\/(\w+)\/draw\/send$/, async (b, m) => {
      let h = helpers.get(m[1]);
      if (!h || h.closed) h = await helperFor(m[1]);
      if (!h.paired) throw err(409, 'Pair with the TV first');
      const ok = new Set(['begin', 'move', 'end', 'undo', 'clear', 'hide', 'text', 'msg']);
      const ops = (Array.isArray(b.ops) ? b.ops : []).filter((o) => o && ok.has(o.t)).slice(0, 300);
      if (ops.length) await h.write(ops);
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
    saveImage(data, name) { return RemoteTv.saveImage({ data, name }); },
    // Links shared to the app from other apps (Share › RemoteTV).
    onShared(cb) {
      RemoteTv.addListener('shared', (e) => cb(e.text)).catch?.(() => {});
      RemoteTv.takeShared().then((r) => { if (r?.text) cb(r.text); }).catch(() => {});
    },
  };
})();
