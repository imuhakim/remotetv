'use strict';
// Roku External Control Protocol (ECP): plain HTTP on port 8060, no pairing.
// Reference: https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
const { request, xmlTag } = require('../http');

const MAP = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Select', back: 'Back', home: 'Home',
  menu: 'Info', info: 'Info', vol_up: 'VolumeUp', vol_down: 'VolumeDown', mute: 'VolumeMute',
  ch_up: 'ChannelUp', ch_down: 'ChannelDown', power: 'Power', power_off: 'PowerOff', input: 'InputTuner',
  search: 'Search', play: 'Play', pause: 'Play', play_pause: 'Play', rewind: 'Rev', forward: 'Fwd',
  prev: 'InstantReplay', next: 'Fwd',
};
for (let i = 0; i <= 9; i++) MAP[String(i)] = `Lit_${i}`;

class RokuDriver {
  constructor(device, emit) {
    this.device = device;
    this.emit = emit;
    this.base = `http://${device.host}:${device.port || 8060}`;
  }

  static get type() { return 'roku'; }
  static get needs() { return []; }

  async connect() {
    const r = await request(`${this.base}/query/device-info`);
    if (!r.ok) throw new Error(`Roku did not answer (${r.status}). Enable "Control by mobile apps".`);
    this.emit('state', { power: xmlTag(r.text, 'power-mode') === 'PowerOn' });
    return true;
  }

  supportedKeys() { return Object.keys(MAP); }

  async sendKey(key, mode = 'short') {
    const k = MAP[key];
    if (!k) throw new Error(`Roku: key "${key}" not supported`);
    const verb = mode === 'start' ? 'keydown' : mode === 'end' ? 'keyup' : 'keypress';
    await request(`${this.base}/${verb}/${k}`, { method: 'POST' });
  }

  async sendText(text) {
    for (const ch of text) await request(`${this.base}/keypress/Lit_${encodeURIComponent(ch)}`, { method: 'POST' });
  }

  async listApps() {
    const r = await request(`${this.base}/query/apps`);
    return [...r.text.matchAll(/<app id="([^"]+)"[^>]*>([^<]*)<\/app>/g)]
      .map((m) => ({ id: m[1], name: m[2], icon: `${this.base}/query/icon/${m[1]}` }));
  }

  async launchApp(id, params = {}) {
    let appId = id;
    if (!/^\d+$/.test(id)) {
      const hit = (await this.listApps()).find((a) => a.name.toLowerCase().includes(String(id).toLowerCase()));
      if (!hit) throw new Error(`App "${id}" not found`);
      appId = hit.id;
    }
    const qs = new URLSearchParams(params).toString();
    await request(`${this.base}/launch/${appId}${qs ? '?' + qs : ''}`, { method: 'POST' });
  }

  async castYouTube(videoId) { await this.launchApp('837', { contentId: videoId, mediaType: 'movie' }); }

  close() {}
}

module.exports = RokuDriver;
