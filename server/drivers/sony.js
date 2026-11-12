'use strict';
// Sony BRAVIA driver: JSON-RPC REST API (/sony/<service>) + IRCC-IP SOAP.
// Auth: Pre-Shared Key sent as "X-Auth-PSK" (TV: Settings > Network >
// Home network > IP control > Authentication = Normal and Pre-Shared Key).
// Reference: https://pro-bravia.sony.net/remote-display-control/
const { request } = require('../http');

// IRCC code = base64 of a 13-byte frame. Category 1 codes share one prefix.
const c1 = (n) => Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, n, 3]).toString('base64');
const c2 = (cat, n) => Buffer.from([0, 0, 0, 2, 0, 0, 0, cat, 0, 0, 0, n, 3]).toString('base64');

// Fallback IRCC codes (used if getRemoteControllerInfo is unavailable).
const FALLBACK = {
  up: c1(0x74), down: c1(0x75), left: c1(0x34), right: c1(0x33), ok: c1(0x65),
  back: c2(0x97, 0x23), home: c1(0x60), menu: c2(0xc4, 0x40), apps: c2(0xc4, 0x40),
  vol_up: c1(0x12), vol_down: c1(0x13), mute: c1(0x14),
  ch_up: c1(0x10), ch_down: c1(0x11), power_off: c1(0x2f), input: c1(0x25),
  info: c1(0x3a), guide: c2(0xa4, 0x5b),
  play: c2(0x97, 0x1a), pause: c2(0x97, 0x19), stop: c2(0x97, 0x18),
  rewind: c2(0x97, 0x1b), forward: c2(0x97, 0x1c), prev: c2(0x97, 0x3c), next: c2(0x97, 0x3d),
  red: c2(0x97, 0x25), green: c2(0x97, 0x26), yellow: c2(0x97, 0x27), blue: c2(0x97, 0x24),
};
for (let i = 1; i <= 9; i++) FALLBACK[String(i)] = c1(i - 1);
FALLBACK['0'] = c1(9);

// Our key name -> Sony getRemoteControllerInfo name (preferred when present).
const NAMES = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Confirm', back: 'Return',
  home: 'Home', menu: 'ActionMenu', apps: 'ActionMenu', vol_up: 'VolumeUp', vol_down: 'VolumeDown',
  mute: 'Mute', ch_up: 'ChannelUp', ch_down: 'ChannelDown', power_off: 'PowerOff', input: 'Input',
  info: 'Display', guide: 'GGuide', play: 'Play', pause: 'Pause', stop: 'Stop', rewind: 'Rewind',
  forward: 'Forward', prev: 'Prev', next: 'Next', red: 'Red', green: 'Green', yellow: 'Yellow',
  blue: 'Blue', settings: 'Options', search: 'GooglePlay',
  0: 'Num0', 1: 'Num1', 2: 'Num2', 3: 'Num3', 4: 'Num4', 5: 'Num5', 6: 'Num6', 7: 'Num7', 8: 'Num8', 9: 'Num9',
};

class SonyDriver {
  constructor(device, emit) {
    this.device = device;
    this.emit = emit;
    this.base = `http://${device.host}${device.port && device.port !== 80 ? ':' + device.port : ''}`;
    this.codes = { ...FALLBACK };
    this.apps = [];
    this.id = 1;
    this.state = {};
  }

  static get type() { return 'sony'; }
  static get needs() { return [{ key: 'psk', label: 'Pre-Shared Key (TV: IP control)', default: '0000' }]; }

  headers(extra = {}) {
    return { 'Content-Type': 'application/json; charset=UTF-8', 'X-Auth-PSK': this.device.psk || '0000', ...extra };
  }

  async rpc(service, method, params = [], version = '1.0') {
    const body = JSON.stringify({ method, id: this.id++, params, version });
    const res = await request(`${this.base}/sony/${service}`, { method: 'POST', headers: this.headers(), body });
    if (res.status === 403) throw new Error('Sony TV rejected the Pre-Shared Key (403). Check IP control settings.');
    let json;
    try { json = JSON.parse(res.text); } catch { throw new Error(`Bad response from TV (${res.status})`); }
    if (json.error) throw new Error(`Sony ${service}.${method}: ${json.error[1] || json.error[0]}`);
    return json.result;
  }

  async connect() {
    // Learn the TV's own IRCC table so model-specific keys work.
    try {
      const r = await this.rpc('system', 'getRemoteControllerInfo');
      const list = Array.isArray(r?.[1]) ? r[1] : [];
      const byName = Object.fromEntries(list.map((x) => [x.name, x.value]));
      for (const [k, n] of Object.entries(NAMES)) if (byName[n]) this.codes[k] = byName[n];
    } catch (e) {
      if (/403|Pre-Shared/.test(e.message)) throw e;
      // Older TVs: keep fallback table.
    }
    await this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), 5000);
    return true;
  }

  async refresh() {
    const next = {};
    const p = await this.rpc('system', 'getPowerStatus');
    next.power = p?.[0]?.status === 'active';
    if (next.power) {
      const v = await this.rpc('audio', 'getVolumeInformation').catch(() => null);
      const spk = v?.[0]?.find((x) => x.target === 'speaker') || v?.[0]?.[0];
      if (spk) { next.volume = spk.volume; next.volumeMax = spk.maxVolume; next.muted = !!spk.mute; }
      const app = await this.rpc('avContent', 'getPlayingContentInfo').catch(() => null);
      if (app?.[0]?.title) next.currentApp = app[0].title;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.emit('state', next);
  }

  async ircc(code) {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
    const headers = this.headers({ 'Content-Type': 'text/xml; charset=UTF-8', SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"' });
    let res = await request(`${this.base}/sony/ircc`, { method: 'POST', headers, body });
    if (res.status === 404) res = await request(`${this.base}/sony/IRCC`, { method: 'POST', headers, body });
    if (res.status === 403) throw new Error('Sony TV rejected the Pre-Shared Key (403).');
    if (!res.ok) throw new Error(`IRCC failed (${res.status})`);
  }

  supportedKeys() { return [...Object.keys(this.codes), 'power', 'play_pause']; }

  async sendKey(key) {
    if (key === 'power') {
      const on = this.state.power;
      if (on === false) return this.rpc('system', 'setPowerStatus', [{ status: true }]).then(() => this.refresh());
      return this.ircc(this.codes.power_off);
    }
    if (key === 'play_pause') {
      key = this.paused ? 'play' : 'pause';
      this.paused = !this.paused;
    }
    const code = this.codes[key];
    if (!code) throw new Error(`Sony: key "${key}" not supported`);
    await this.ircc(code);
    if (/vol|mute|power/.test(key)) setTimeout(() => this.refresh().catch(() => {}), 300);
  }

  async setVolume(level) {
    await this.rpc('audio', 'setAudioVolume', [{ target: 'speaker', volume: String(level) }]);
    await this.refresh();
  }

  async sendText(text) {
    // Works while a text field is focused on the TV.
    try { await this.rpc('appControl', 'setTextForm', [{ text }], '1.1'); }
    catch { await this.rpc('appControl', 'setTextForm', [text], '1.0'); }
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
    // id may be a Sony app URI or a friendly name such as "YouTube".
    let uri = id;
    if (!/^com\.sony\.|^localapp:|:\/\//.test(id)) {
      const apps = await this.listApps();
      const hit = apps.find((a) => a.name.toLowerCase() === id.toLowerCase())
        || apps.find((a) => a.name.toLowerCase().includes(id.toLowerCase()));
      if (!hit) throw new Error(`App "${id}" not found on TV`);
      uri = hit.id;
    }
    await this.rpc('appControl', 'setActiveApp', [{ uri }]);
  }

  async listInputs() {
    const r = await this.rpc('avContent', 'getCurrentExternalInputsStatus');
    return (r?.[0] || []).map((i) => ({ id: i.uri, name: i.label || i.title, connected: i.connection }));
  }

  async setInput(uri) { await this.rpc('avContent', 'setPlayContent', [{ uri }]); }

  close() { clearInterval(this.timer); }
}

module.exports = SonyDriver;
module.exports.FALLBACK = FALLBACK;
