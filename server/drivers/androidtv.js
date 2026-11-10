'use strict';
// Android TV / Google TV driver using the official "Android TV Remote
// Service" protocol v2 (TLS, pairing port 6467, remote port 6466) — the
// same protocol the Google TV phone app uses. Works on Sony BRAVIA Android
// TVs (e.g. KD-55X7500F), Chromecast with Google TV, TCL, Xiaomi, Philips...
// Library: https://github.com/louis49/androidtv-remote
// Loaded lazily: the library probes system info (dmidecode on Linux) at
// require time, which must not happen unless an Android TV is actually used.
let lib;
const atv = () => (lib ||= require('androidtv-remote'));

const MAP = {
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
  ok: 'KEYCODE_DPAD_CENTER', back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', menu: 'KEYCODE_MENU',
  apps: 'KEYCODE_ALL_APPS', vol_up: 'KEYCODE_VOLUME_UP', vol_down: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE',
  ch_up: 'KEYCODE_CHANNEL_UP', ch_down: 'KEYCODE_CHANNEL_DOWN', power: 'KEYCODE_POWER', power_off: 'KEYCODE_SLEEP',
  input: 'KEYCODE_TV_INPUT', info: 'KEYCODE_INFO', guide: 'KEYCODE_GUIDE', settings: 'KEYCODE_SETTINGS',
  search: 'KEYCODE_SEARCH', play: 'KEYCODE_MEDIA_PLAY', pause: 'KEYCODE_MEDIA_PAUSE',
  play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE', stop: 'KEYCODE_MEDIA_STOP', rewind: 'KEYCODE_MEDIA_REWIND',
  forward: 'KEYCODE_MEDIA_FAST_FORWARD', prev: 'KEYCODE_MEDIA_PREVIOUS', next: 'KEYCODE_MEDIA_NEXT',
  red: 'KEYCODE_PROG_RED', green: 'KEYCODE_PROG_GREEN', yellow: 'KEYCODE_PROG_YELLOW', blue: 'KEYCODE_PROG_BLUE',
};
for (let i = 0; i <= 9; i++) MAP[String(i)] = `KEYCODE_${i}`;

// Deep links understood by the Android TV launcher (sendAppLink).
const APP_LINKS = {
  youtube: 'https://www.youtube.com',
  netflix: 'https://www.netflix.com/title',
  'prime video': 'https://app.primevideo.com',
  prime: 'https://app.primevideo.com',
  'disney+': 'https://www.disneyplus.com',
  spotify: 'spotify://',
  'google tv': 'market://launcher',
};

class AndroidTvDriver {
  constructor(device, emit) {
    this.device = device;
    this.emit = emit;
    this.state = {};
  }

  static get type() { return 'androidtv'; }
  static get needs() { return []; }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { pairing_port: 6467, remote_port: 6466, name: 'RemoteTV Hub', cert: this.device.cert || {} };
      const r = new (atv().AndroidRemote)(this.device.host, opts);
      this.remote = r;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      r.on('secret', () => {
        // TV shows a 6-character code; the UI collects it and calls pair().
        this.emit('pairing', { message: 'Enter the code shown on your TV' });
        done(resolve, 'pairing');
      });
      r.on('ready', () => {
        this.emit('persist', { cert: r.getCertificate() });
        this.emit('state', this.patch({ connected: true }));
        done(resolve, true);
      });
      r.on('powered', (p) => this.emit('state', this.patch({ power: !!p })));
      r.on('volume', (v) => this.emit('state', this.patch({ volume: v.level, volumeMax: v.maximum, muted: !!v.muted })));
      r.on('current_app', (a) => this.emit('state', this.patch({ currentApp: a })));
      r.on('error', (e) => {
        this.emit('error', String(e?.message || e));
        done(reject, e instanceof Error ? e : new Error(String(e)));
      });
      r.on('unpaired', () => this.emit('pairing', { message: 'TV forgot this hub — pair again' }));
      r.start().catch((e) => done(reject, e));
      setTimeout(() => done(reject, new Error('Android TV did not answer on ports 6466/6467')), 15000);
    });
  }

  patch(p) { this.state = { ...this.state, ...p }; return this.state; }

  async pair(code) {
    if (!this.remote) throw new Error('Not connecting');
    this.remote.sendCode(String(code).trim().toUpperCase());
  }

  supportedKeys() { return Object.keys(MAP).filter((k) => atv().RemoteKeyCode[MAP[k]] !== undefined); }

  async sendKey(key, mode = 'short') {
    const { RemoteKeyCode, RemoteDirection } = atv();
    const code = RemoteKeyCode[MAP[key]];
    if (code === undefined) throw new Error(`Android TV: key "${key}" not supported`);
    const dir = mode === 'start' ? RemoteDirection.START_LONG
      : mode === 'end' ? RemoteDirection.END_LONG : RemoteDirection.SHORT;
    this.remote.sendKey(code, dir);
  }

  async launchApp(id) {
    const link = APP_LINKS[String(id).toLowerCase()] || id;
    if (!/:\/\/|^market:/.test(link)) throw new Error(`Unknown app "${id}". Use a deep link such as https://www.youtube.com`);
    this.remote.sendAppLink(link);
  }

  async openUrl(url) { this.remote.sendAppLink(url); }

  async listApps() { return Object.keys(APP_LINKS).map((n) => ({ id: APP_LINKS[n], name: n })); }

  close() { try { this.remote?.stop(); } catch { /* ignore */ } }
}

module.exports = AndroidTvDriver;
