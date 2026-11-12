'use strict';
/* In-app TV drivers for the Android APK build (no hub needed).
 * HTTP goes through CapacitorHttp (patched fetch: no CORS, cleartext allowed);
 * raw TLS sockets come from the RemoteTv native plugin. */
(function () {
  const RemoteTv = window.Capacitor.registerPlugin('RemoteTv');

  async function req(url, { method = 'GET', headers = {}, body, timeout = 4000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
      return { ok: r.ok, status: r.status, headers: r.headers, text: await r.text() };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `Timeout calling ${url}` : `Cannot reach ${url}`);
    } finally { clearTimeout(t); }
  }
  const xmlTag = (xml, tag) => {
    const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml || '');
    return m ? m[1].trim() : null;
  };
  const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

  // ================================================================= Sony
  const b64 = (arr) => btoa(String.fromCharCode(...arr));
  const c1 = (n) => b64([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, n, 3]);
  const c2 = (cat, n) => b64([0, 0, 0, 2, 0, 0, 0, cat, 0, 0, 0, n, 3]);
  const SONY_FALLBACK = {
    up: c1(0x74), down: c1(0x75), left: c1(0x34), right: c1(0x33), ok: c1(0x65), back: c2(0x97, 0x23),
    home: c1(0x60), menu: c2(0xc4, 0x40), apps: c2(0xc4, 0x40), vol_up: c1(0x12), vol_down: c1(0x13), mute: c1(0x14),
    ch_up: c1(0x10), ch_down: c1(0x11), power_off: c1(0x2f), input: c1(0x25), info: c1(0x3a), guide: c2(0xa4, 0x5b),
    play: c2(0x97, 0x1a), pause: c2(0x97, 0x19), stop: c2(0x97, 0x18), rewind: c2(0x97, 0x1b), forward: c2(0x97, 0x1c),
    prev: c2(0x97, 0x3c), next: c2(0x97, 0x3d), red: c2(0x97, 0x25), green: c2(0x97, 0x26), yellow: c2(0x97, 0x27), blue: c2(0x97, 0x24),
  };
  for (let i = 1; i <= 9; i++) SONY_FALLBACK[String(i)] = c1(i - 1);
  SONY_FALLBACK['0'] = c1(9);
  const SONY_NAMES = {
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Confirm', back: 'Return', home: 'Home', menu: 'ActionMenu',
    apps: 'ActionMenu', vol_up: 'VolumeUp', vol_down: 'VolumeDown', mute: 'Mute', ch_up: 'ChannelUp', ch_down: 'ChannelDown',
    power_off: 'PowerOff', input: 'Input', info: 'Display', guide: 'GGuide', play: 'Play', pause: 'Pause', stop: 'Stop',
    rewind: 'Rewind', forward: 'Forward', prev: 'Prev', next: 'Next', red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue',
    settings: 'Options', search: 'GooglePlay',
  };
  for (let i = 0; i <= 9; i++) SONY_NAMES[String(i)] = `Num${i}`;

  class Sony {
    constructor(device, emit) {
      this.device = device; this.emit = emit; this.codes = { ...SONY_FALLBACK }; this.apps = []; this.id = 1; this.state = {};
      this.base = `http://${device.host}${device.port && device.port !== 80 ? ':' + device.port : ''}`;
    }
    hdr(extra = {}) { return { 'Content-Type': 'application/json; charset=UTF-8', 'X-Auth-PSK': this.device.psk || '0000', ...extra }; }
    async rpc(service, method, params = [], version = '1.0') {
      const r = await req(`${this.base}/sony/${service}`, { method: 'POST', headers: this.hdr(), body: JSON.stringify({ method, id: this.id++, params, version }) });
      if (r.status === 403) throw new Error('Sony TV rejected the Pre-Shared Key (403). Check IP control settings.');
      let j; try { j = JSON.parse(r.text); } catch { throw new Error(`Bad response from TV (${r.status})`); }
      if (j.error) throw new Error(`Sony ${service}.${method}: ${j.error[1] || j.error[0]}`);
      return j.result;
    }
    async connect() {
      try {
        const r = await this.rpc('system', 'getRemoteControllerInfo');
        const by = Object.fromEntries((r?.[1] || []).map((x) => [x.name, x.value]));
        for (const [k, n] of Object.entries(SONY_NAMES)) if (by[n]) this.codes[k] = by[n];
      } catch (e) { if (/403|Pre-Shared/.test(e.message)) throw e; }
      await this.refresh().catch(() => {});
      this.timer = setInterval(() => this.refresh().catch(() => {}), 5000);
      return true;
    }
    async refresh() {
      const n = {};
      const p = await this.rpc('system', 'getPowerStatus');
      n.power = p?.[0]?.status === 'active';
      if (n.power) {
        const v = await this.rpc('audio', 'getVolumeInformation').catch(() => null);
        const s = v?.[0]?.find((x) => x.target === 'speaker') || v?.[0]?.[0];
        if (s) { n.volume = s.volume; n.volumeMax = s.maxVolume; n.muted = !!s.mute; }
      }
      if (JSON.stringify(n) !== JSON.stringify(this.state)) { this.state = n; this.emit('state', n); }
    }
    async ircc(code) {
      const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
      const headers = this.hdr({ 'Content-Type': 'text/xml; charset=UTF-8', SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"' });
      let r = await req(`${this.base}/sony/ircc`, { method: 'POST', headers, body });
      if (r.status === 404) r = await req(`${this.base}/sony/IRCC`, { method: 'POST', headers, body });
      if (r.status === 403) throw new Error('Sony TV rejected the Pre-Shared Key (403).');
      if (!r.ok) throw new Error(`IRCC failed (${r.status})`);
    }
    async sendKey(key) {
      if (key === 'power') {
        if (this.state.power === false) { await this.rpc('system', 'setPowerStatus', [{ status: true }]); return this.refresh(); }
        return this.ircc(this.codes.power_off);
      }
      if (key === 'play_pause') { key = this.paused ? 'play' : 'pause'; this.paused = !this.paused; }
      if (!this.codes[key]) throw new Error(`Sony: key "${key}" not supported`);
      await this.ircc(this.codes[key]);
      if (/vol|mute/.test(key)) setTimeout(() => this.refresh().catch(() => {}), 300);
    }
    async setVolume(level) { await this.rpc('audio', 'setAudioVolume', [{ target: 'speaker', volume: String(level) }]); await this.refresh(); }
    async sendText(text) {
      try { await this.rpc('appControl', 'setTextForm', [{ text }], '1.1'); } catch { await this.rpc('appControl', 'setTextForm', [text], '1.0'); }
    }
    async listApps() {
      if (!this.apps.length) {
        const r = await this.rpc('appControl', 'getApplicationList');
        this.apps = (r?.[0] || []).map((a) => ({ id: a.uri, name: a.title, icon: a.icon || null }));
      }
      return this.apps;
    }
    async openUrl(url) { await this.rpc('appControl', 'setActiveApp', [{ uri: `localapp://webappruntime?url=${encodeURIComponent(url)}` }]); }
    async launchApp(id) {
      let uri = id;
      if (!/^com\.sony\.|^localapp:|:\/\//.test(id)) {
        const apps = await this.listApps();
        const low = id.toLowerCase();
        const hit = apps.find((a) => a.name.toLowerCase() === low) || apps.find((a) => a.name.toLowerCase().includes(low));
        if (!hit) throw new Error(`App "${id}" not found on TV`);
        uri = hit.id;
      }
      await this.rpc('appControl', 'setActiveApp', [{ uri }]);
    }
    async listInputs() {
      const r = await this.rpc('avContent', 'getCurrentExternalInputsStatus');
      return (r?.[0] || []).map((i) => ({ id: i.uri, name: i.label || i.title }));
    }
    async setInput(uri) { await this.rpc('avContent', 'setPlayContent', [{ uri }]); }
    close() { clearInterval(this.timer); }
  }

  // ================================================================= Roku
  const ROKU = {
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Select', back: 'Back', home: 'Home', menu: 'Info', info: 'Info',
    vol_up: 'VolumeUp', vol_down: 'VolumeDown', mute: 'VolumeMute', ch_up: 'ChannelUp', ch_down: 'ChannelDown', power: 'Power',
    power_off: 'PowerOff', input: 'InputTuner', search: 'Search', play: 'Play', pause: 'Play', play_pause: 'Play', rewind: 'Rev',
    forward: 'Fwd', prev: 'InstantReplay', next: 'Fwd',
  };
  for (let i = 0; i <= 9; i++) ROKU[String(i)] = `Lit_${i}`;
  class Roku {
    constructor(device, emit) { this.device = device; this.emit = emit; this.base = `http://${device.host}:${device.port || 8060}`; }
    async connect() {
      const r = await req(`${this.base}/query/device-info`);
      if (!r.ok) throw new Error('Roku did not answer. Enable "Control by mobile apps".');
      this.emit('state', { power: xmlTag(r.text, 'power-mode') === 'PowerOn' });
      return true;
    }
    async sendKey(key) {
      if (!ROKU[key]) throw new Error(`Roku: key "${key}" not supported`);
      await req(`${this.base}/keypress/${ROKU[key]}`, { method: 'POST' });
    }
    async sendText(text) { for (const ch of text) await req(`${this.base}/keypress/Lit_${encodeURIComponent(ch)}`, { method: 'POST' }); }
    async listApps() {
      const r = await req(`${this.base}/query/apps`);
      return [...r.text.matchAll(/<app id="([^"]+)"[^>]*>([^<]*)<\/app>/g)].map((m) => ({ id: m[1], name: m[2], icon: `${this.base}/query/icon/${m[1]}` }));
    }
    async launchApp(id, params = {}) {
      let appId = id;
      if (!/^\d+$/.test(id)) {
        const hit = (await this.listApps()).find((a) => a.name.toLowerCase().includes(String(id).toLowerCase()));
        if (!hit) throw new Error(`App "${id}" not found`);
        appId = hit.id;
      }
      const qs = new URLSearchParams(params).toString();
      await req(`${this.base}/launch/${appId}${qs ? '?' + qs : ''}`, { method: 'POST' });
    }
    async castYouTube(v) { await this.launchApp('837', { contentId: v, mediaType: 'movie' }); }
    close() {}
  }

  // ============================================================ Android TV
  // Android TV Remote protocol v2: pairing on 6467, commands on 6466, both TLS
  // with a client certificate. Messages are varint-length-delimited protobuf.
  let protoRoot;
  function protos() {
    if (!protoRoot) {
      const pb = window.protobuf;
      const pairing = pb.parse(window.TV_PROTOS.pairing).root;
      const remote = pb.parse(window.TV_PROTOS.remote).root;
      protoRoot = {
        Pairing: pairing.lookupType('pairing.PairingMessage'),
        Remote: remote.lookupType('remote.RemoteMessage'),
        Key: remote.lookupEnum('remote.RemoteKeyCode').values,
        Dir: remote.lookupEnum('remote.RemoteDirection').values,
      };
    }
    return protoRoot;
  }

  const u8ToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64ToU8 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const hexToU8 = (h) => { if (h.length % 2) h = '0' + h; return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16)); };

  // One client certificate per install, reused for every Android TV.
  async function clientIdentity() {
    try { const c = JSON.parse(localStorage.getItem('remotetv.atv.identity')); if (c?.cert && c?.key) return c; } catch { /* regenerate */ }
    const forge = window.forge;
    let keys;
    try {
      // WebCrypto keeps the UI responsive while generating the 2048-bit key.
      const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
      const priv = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(pkcs8)));
      keys = { privateKey: priv, publicKey: forge.pki.setRsaPublicKey(priv.n, priv.e) };
    } catch {
      keys = forge.pki.rsa.generateKeyPair(2048);
    }
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date('2099-01-01T00:00:00Z');
    const attrs = [{ name: 'commonName', value: 'RemoteTV' }, { name: 'organizationName', value: 'RemoteTV' }, { name: 'countryName', value: 'MY' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const id = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))),
    };
    localStorage.setItem('remotetv.atv.identity', JSON.stringify(id));
    return id;
  }

  // Wraps a native TLS socket and splits the stream into protobuf messages.
  const sockets = new Map();
  let listening = false;
  async function listenSockets() {
    if (listening) return;
    listening = true;
    await RemoteTv.addListener('tlsData', (ev) => sockets.get(ev.id)?.onData(b64ToU8(ev.data)));
    await RemoteTv.addListener('tlsClose', (ev) => { const s = sockets.get(ev.id); sockets.delete(ev.id); s?.onClose(ev.error); });
  }
  class Framed {
    constructor(type, onMessage, onClose) { this.type = type; this.onMessage = onMessage; this.closeCb = onClose; this.buf = new Uint8Array(0); }
    async open(host, port, ident) {
      await listenSockets();
      const r = await RemoteTv.tlsConnect({ host, port, certPem: ident.cert, keyPem: ident.key, timeoutMs: 6000 });
      this.id = r.id;
      this.peerCert = r.peerCert;
      sockets.set(r.id, this);
      return this;
    }
    onData(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      this.buf = merged;
      for (;;) {
        let len = 0, shift = 0, i = 0;
        for (; i < this.buf.length && i < 5; i++) {
          len |= (this.buf[i] & 0x7f) << shift; shift += 7;
          if (!(this.buf[i] & 0x80)) break;
        }
        if (i >= this.buf.length || this.buf.length < i + 1 + len) return; // wait for more
        const msg = this.buf.subarray(i + 1, i + 1 + len);
        this.buf = this.buf.slice(i + 1 + len);
        try { this.onMessage(this.type.decode(msg)); } catch (e) { console.warn('ATV decode', e); }
      }
    }
    onClose(err) { this.closed = true; this.closeCb?.(err); }
    send(payload) {
      const err = this.type.verify(payload);
      if (err) throw new Error(err);
      const bytes = this.type.encodeDelimited(this.type.create(payload)).finish();
      return RemoteTv.tlsWrite({ id: this.id, data: u8ToB64(bytes) });
    }
    close() { this.closed = true; return RemoteTv.tlsClose({ id: this.id }).catch(() => {}); }
  }

  const ATV_KEYS = {
    up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', ok: 'KEYCODE_DPAD_CENTER',
    back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', menu: 'KEYCODE_MENU', apps: 'KEYCODE_ALL_APPS', vol_up: 'KEYCODE_VOLUME_UP',
    vol_down: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE', ch_up: 'KEYCODE_CHANNEL_UP', ch_down: 'KEYCODE_CHANNEL_DOWN',
    power: 'KEYCODE_POWER', power_off: 'KEYCODE_SLEEP', input: 'KEYCODE_TV_INPUT', info: 'KEYCODE_INFO', guide: 'KEYCODE_GUIDE',
    settings: 'KEYCODE_SETTINGS', search: 'KEYCODE_SEARCH', play: 'KEYCODE_MEDIA_PLAY', pause: 'KEYCODE_MEDIA_PAUSE',
    play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE', stop: 'KEYCODE_MEDIA_STOP', rewind: 'KEYCODE_MEDIA_REWIND', forward: 'KEYCODE_MEDIA_FAST_FORWARD',
    prev: 'KEYCODE_MEDIA_PREVIOUS', next: 'KEYCODE_MEDIA_NEXT', red: 'KEYCODE_PROG_RED', green: 'KEYCODE_PROG_GREEN',
    yellow: 'KEYCODE_PROG_YELLOW', blue: 'KEYCODE_PROG_BLUE',
  };
  for (let i = 0; i <= 9; i++) ATV_KEYS[String(i)] = `KEYCODE_${i}`;
  const ATV_LINKS = {
    youtube: 'https://www.youtube.com', netflix: 'https://www.netflix.com/title', 'prime video': 'https://app.primevideo.com',
    prime: 'https://app.primevideo.com', 'disney+': 'https://www.disneyplus.com', spotify: 'spotify://',
  };

  class AndroidTv {
    constructor(device, emit) { this.device = device; this.emit = emit; this.state = {}; this.failures = 0; }

    async connect() {
      this.ident = await clientIdentity();
      if (!this.device.paired) { await this.startPairing(); return 'pairing'; }
      try { await this.openRemote(); return true; }
      catch (e) {
        // Certificate unknown to the TV (factory reset, new app install...): pair again.
        if (/Handshake|reset|closed|EOF|SSL/i.test(e.message)) { await this.startPairing(); return 'pairing'; }
        throw new Error(`Android TV not reachable on port 6466: ${e.message}`);
      }
    }

    async startPairing() {
      const { Pairing } = protos();
      const OK = 200;
      this.pairing = new Framed(Pairing, (m) => {
        if (m.status !== OK) { this.emit('error', `Pairing refused by TV (status ${m.status})`); this.pairing.close(); return; }
        if (m.pairingRequestAck) {
          this.pairing.send({ pairingOption: { preferredRole: 1, inputEncodings: [{ type: 3, symbolLength: 6 }] }, status: OK, protocolVersion: 2 });
        } else if (m.pairingOption) {
          this.pairing.send({ pairingConfiguration: { clientRole: 1, encoding: { type: 3, symbolLength: 6 } }, status: OK, protocolVersion: 2 });
        } else if (m.pairingConfigurationAck) {
          this.emit('pairing', { message: 'Enter the 6-character code shown on your TV' });
        } else if (m.pairingSecretAck) {
          this.pairing.close();
          this.emit('persist', { paired: true });
          this.device.paired = true;
          this.openRemote().then(() => this.emit('paired', {})).catch((e) => this.emit('error', e.message));
        }
      }, (err) => { if (err && !this.device.paired) this.emit('error', `Pairing connection closed: ${err}`); });
      await this.pairing.open(this.device.host, 6467, this.ident);
      await this.pairing.send({ pairingRequest: { serviceName: 'com.google.android.videos', clientName: 'RemoteTV' }, status: OK, protocolVersion: 2 });
    }

    async pair(code) {
      code = String(code).trim().toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(code)) throw new Error('The code is 6 characters (0-9, A-F)');
      const forge = window.forge;
      const client = forge.pki.certificateFromPem(this.ident.cert).publicKey;
      const server = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(this.pairing.peerCert))).publicKey;
      const parts = [client.n.toString(16), client.e.toString(16), server.n.toString(16), server.e.toString(16), code.slice(2)].map(hexToU8);
      const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
      if (hash[0] !== parseInt(code.slice(0, 2), 16)) throw new Error('Wrong code — check the TV and try again');
      await this.pairing.send({ pairingSecret: { secret: hash }, status: 200, protocolVersion: 2 });
    }

    async openRemote() {
      const { Remote } = protos();
      if (this.remote && !this.remote.closed) return;
      this.remote = new Framed(Remote, (m) => this.onRemote(m), (err) => {
        this.emit('state', this.patch({ connected: false }));
        if (this.stopped) return;
        // Reconnect with backoff (TV asleep, Wi-Fi blip...).
        const wait = Math.min(30000, 1000 * 2 ** this.failures++);
        setTimeout(() => this.openRemote().then(() => { this.failures = 0; }).catch(() => {}), wait);
        if (err) console.warn('ATV remote closed', err);
      });
      await this.remote.open(this.device.host, 6466, this.ident);
      this.emit('state', this.patch({ connected: true }));
    }

    onRemote(m) {
      if (m.remoteConfigure) {
        this.remote.send({ remoteConfigure: { code1: 622, deviceInfo: { model: 'RemoteTV', vendor: 'RemoteTV', unknown1: 1, unknown2: '1', packageName: 'io.github.imuhakim.remotetv', appVersion: '1.1.0' } } });
      } else if (m.remoteSetActive) {
        this.remote.send({ remoteSetActive: { active: 622 } });
      } else if (m.remotePingRequest) {
        this.remote.send({ remotePingResponse: { val1: m.remotePingRequest.val1 } });
      } else if (m.remoteStart) {
        this.emit('state', this.patch({ power: !!m.remoteStart.started }));
      } else if (m.remoteSetVolumeLevel) {
        const v = m.remoteSetVolumeLevel;
        this.emit('state', this.patch({ volume: v.volumeLevel, volumeMax: v.volumeMax, muted: !!v.volumeMuted }));
      } else if (m.remoteImeKeyInject?.appInfo?.appPackage) {
        this.emit('state', this.patch({ currentApp: m.remoteImeKeyInject.appInfo.appPackage }));
      }
    }

    patch(p) { this.state = { ...this.state, ...p }; return this.state; }

    async ready() {
      if (!this.remote || this.remote.closed) await this.openRemote();
    }

    async sendKey(key, mode = 'short') {
      const { Key, Dir } = protos();
      const code = Key[ATV_KEYS[key]];
      if (code === undefined) throw new Error(`Android TV: key "${key}" not supported`);
      await this.ready();
      const direction = mode === 'start' ? Dir.START_LONG : mode === 'end' ? Dir.END_LONG : Dir.SHORT;
      await this.remote.send({ remoteKeyInject: { keyCode: code, direction } });
    }

    async launchApp(id) {
      const link = ATV_LINKS[String(id).toLowerCase()] || id;
      if (!/:\/\//.test(link)) throw new Error(`Unknown app "${id}". Use a link such as https://www.youtube.com`);
      await this.ready();
      await this.remote.send({ remoteAppLinkLaunchRequest: { appLink: link } });
    }
    async openUrl(url) { return this.launchApp(url); }
    async castYouTube(v) { return this.launchApp(`https://www.youtube.com/watch?v=${v}`); }
    async listApps() { return Object.entries(ATV_LINKS).filter(([n]) => n !== 'prime').map(([name, id]) => ({ id, name })); }

    close() { this.stopped = true; this.remote?.close(); this.pairing?.close(); }
  }

  // ============================================================ DLNA / DIAL
  const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
  const avtCache = new Map();
  async function avt(location) {
    if (avtCache.has(location)) return avtCache.get(location);
    const r = await req(location);
    for (const block of r.text.split(/<service>/i).slice(1)) {
      if (xmlTag(block, 'serviceType') === AVT) {
        const url = new URL(xmlTag(block, 'controlURL'), location).toString();
        avtCache.set(location, url);
        return url;
      }
    }
    throw new Error('TV does not expose a DLNA media renderer');
  }
  async function soap(ctl, action, args) {
    const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${AVT}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const r = await req(ctl, { method: 'POST', body, timeout: 8000, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${AVT}#${action}"` } });
    if (!r.ok) throw new Error(`${action} failed (${r.status}) ${xmlTag(r.text, 'errorDescription') || ''}`);
    return r.text;
  }
  function didl(url, mime, title) {
    const cls = mime.startsWith('image/') ? 'object.item.imageItem.photo' : mime.startsWith('audio/') ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${xmlEscape(title)}</dc:title><upnp:class>${cls}</upnp:class><res protocolInfo="http-get:*:${mime}:*">${xmlEscape(url)}</res></item></DIDL-Lite>`;
  }
  const cast = {
    async play(location, url, mime = 'video/mp4', title = 'RemoteTV') {
      const ctl = await avt(location);
      await soap(ctl, 'Stop', { InstanceID: 0 }).catch(() => {});
      await soap(ctl, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl(url, mime, title) });
      await soap(ctl, 'Play', { InstanceID: 0, Speed: 1 });
    },
    async control(location, action, value) {
      const ctl = await avt(location);
      if (action === 'pause') return soap(ctl, 'Pause', { InstanceID: 0 });
      if (action === 'resume') return soap(ctl, 'Play', { InstanceID: 0, Speed: 1 });
      if (action === 'stop') return soap(ctl, 'Stop', { InstanceID: 0 });
      if (action === 'seek') return soap(ctl, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: value });
      throw new Error(`Unknown cast action ${action}`);
    },
    async status(location) {
      const ctl = await avt(location);
      const [t, p] = await Promise.all([soap(ctl, 'GetTransportInfo', { InstanceID: 0 }), soap(ctl, 'GetPositionInfo', { InstanceID: 0 })]);
      return { state: xmlTag(t, 'CurrentTransportState'), position: xmlTag(p, 'RelTime'), duration: xmlTag(p, 'TrackDuration') };
    },
    async dialYouTube(dialUrl, v) {
      const base = dialUrl.endsWith('/') ? dialUrl : dialUrl + '/';
      const r = await req(`${base}YouTube`, { method: 'POST', body: `v=${encodeURIComponent(v)}`, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      if (!(r.status === 201 || r.ok)) throw new Error(`DIAL YouTube launch failed (${r.status})`);
    },
    youtubeId(input) {
      const s = String(input).trim();
      if (/^[\w-]{11}$/.test(s)) return s;
      const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(s);
      if (!m) throw new Error('Not a YouTube link');
      return m[1];
    },
  };

  // ============================================================ Sony IR
  // Uses the phone's infra-red emitter (ConsumerIrManager). Sony IRCC codes
  // are the TV's own SIRC IR codes: 13 bytes = [type][device][command][3],
  // type 1 = 12-bit (5-bit device), 2 = 15-bit (8-bit device), 3 = 20-bit.
  function irccToSirc(code) {
    const b = Uint8Array.from(atob(code), (c) => c.charCodeAt(0));
    const word = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = word(0), dev = word(4), cmd = word(8);
    if (type === 1) return { cmd, bits: [[cmd, 7], [dev, 5]] };
    if (type === 2) return { cmd, bits: [[cmd, 7], [dev, 8]] };
    if (type === 3) return { cmd, bits: [[cmd, 7], [dev & 0xff, 5], [dev >> 8, 8]] }; // [ext<<8 | device]
    throw new Error('Unknown Sony code type');
  }
  // SIRC: 40 kHz, 2.4 ms header, "1" = 1.2 ms mark, "0" = 0.6 ms mark, 0.6 ms
  // spaces, LSB first, frames every 45 ms. Sony TVs want the frame 3 times.
  function sircPattern(bits, repeats = 3) {
    const frame = [2400, 600];
    for (const [value, n] of bits) for (let i = 0; i < n; i++) frame.push((value >> i) & 1 ? 1200 : 600, 600);
    const len = frame.reduce((a, x) => a + x, 0);
    frame[frame.length - 1] += Math.max(0, 45000 - len);
    const out = [];
    for (let r = 0; r < repeats; r++) out.push(...frame);
    out.pop(); // end on a mark
    return out;
  }
  const SONY_IR = { ...SONY_FALLBACK, power: c1(0x15), power_on: c1(0x2e) }; // 0x15 = power toggle

  // NEC (LG and many others) and Samsung32: 38 kHz, 32 bits LSB first,
  // 560 us marks, "1" = 1690 us space, "0" = 560 us space, then a stop mark.
  function pulse32(header, bytes) {
    const out = [...header];
    for (const byte of bytes) for (let i = 0; i < 8; i++) out.push(560, (byte >> i) & 1 ? 1690 : 560);
    out.push(560);
    return out;
  }
  const necPattern = (addr, cmd) => pulse32([9000, 4500], [addr, ~addr & 0xff, cmd, ~cmd & 0xff]);
  const samsungPattern = (addr, cmd) => pulse32([4500, 4500], [addr, addr, cmd, ~cmd & 0xff]);
  const digits = (codes) => Object.fromEntries(codes.map((c, i) => [String(i), c]));

  // Widely published TV codes. Samsung: Samsung32 address 0x07. LG: NEC address 0x04.
  const SAMSUNG_IR = {
    power: 0x02, power_off: 0x98, input: 0x01, vol_up: 0x07, vol_down: 0x0b, mute: 0x0f, ch_up: 0x12, ch_down: 0x10,
    menu: 0x1a, settings: 0x1a, up: 0x60, down: 0x61, left: 0x65, right: 0x62, ok: 0x68, back: 0x58, home: 0x79, info: 0x1f,
    guide: 0x4f, play: 0x47, pause: 0x4a, stop: 0x46, rewind: 0x45, forward: 0x48, red: 0x6c, green: 0x14, yellow: 0x15, blue: 0x16,
    ...digits([0x11, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x0e]),
  };
  const LG_IR = {
    power: 0x08, power_on: 0xc4, power_off: 0xc5, input: 0x0b, vol_up: 0x02, vol_down: 0x03, mute: 0x09, ch_up: 0x00, ch_down: 0x01,
    menu: 0x43, settings: 0x43, up: 0x40, down: 0x41, left: 0x07, right: 0x06, ok: 0x44, back: 0x28, home: 0x7c, info: 0xaa,
    guide: 0xa9, play: 0xb0, pause: 0xba, stop: 0xb1, rewind: 0x8f, forward: 0x8e, red: 0x72, green: 0x71, yellow: 0x63, blue: 0x61,
    ...digits([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19]),
  };
  const IR_BRANDS = {
    sony: { label: 'Sony', freq: 40000, pattern: (k) => SONY_IR[k] && sircPattern(irccToSirc(SONY_IR[k]).bits) },
    samsung: { label: 'Samsung', freq: 38000, pattern: (k) => SAMSUNG_IR[k] !== undefined && samsungPattern(0x07, SAMSUNG_IR[k]) },
    lg: { label: 'LG', freq: 38000, pattern: (k) => LG_IR[k] !== undefined && necPattern(0x04, LG_IR[k]) },
  };

  // Infra-red TV: device.brand picks the code set ("sony_ir" devices are Sony).
  class IrTv {
    constructor(device) { this.device = device; this.brand = IR_BRANDS[device.brand || 'sony'] || IR_BRANDS.sony; }
    async connect() {
      const r = await RemoteTv.irInfo().catch(() => ({ hasIr: false }));
      if (!r.hasIr) throw new Error('This phone has no infra-red emitter. Use Wi-Fi mode (Android TV or Sony BRAVIA) instead.');
      return true;
    }
    async sendKey(key) {
      if (key === 'play_pause') { key = this.paused ? 'play' : 'pause'; this.paused = !this.paused; }
      const pattern = this.brand.pattern(key);
      if (!pattern) throw new Error(`Key "${key}" is not available over infra-red for ${this.brand.label}`);
      await RemoteTv.irTransmit({ frequency: this.brand.freq, pattern });
    }
    async launchApp() { throw new Error('Opening apps needs Wi-Fi mode. Over infra-red use Home and the arrows.'); }
    close() {}
  }

  window.NativeTv = { RemoteTv, req, xmlTag, drivers: { sony: Sony, roku: Roku, androidtv: AndroidTv, sony_ir: IrTv, ir: IrTv }, cast,
    ir: { irccToSirc, sircPattern, necPattern, samsungPattern, SONY_IR, SAMSUNG_IR, LG_IR, BRANDS: Object.keys(IR_BRANDS) },
    net: { listenSockets, sockets, u8ToB64, b64ToU8, clientIdentity } };
})();
