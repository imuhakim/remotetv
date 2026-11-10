'use strict';
// Samsung Tizen (2016+) driver: WebSocket remote channel on wss://:8002.
// First connection shows "Allow" on the TV; the returned token is saved.
// Protocol as used by https://github.com/Toxblh/samsung-tv-control
const WebSocket = require('ws');

const MAP = {
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_ENTER', back: 'KEY_RETURN',
  home: 'KEY_HOME', menu: 'KEY_MENU', apps: 'KEY_APPS', vol_up: 'KEY_VOLUP', vol_down: 'KEY_VOLDOWN',
  mute: 'KEY_MUTE', ch_up: 'KEY_CHUP', ch_down: 'KEY_CHDOWN', power: 'KEY_POWER', power_off: 'KEY_POWEROFF',
  input: 'KEY_SOURCE', info: 'KEY_INFO', guide: 'KEY_GUIDE', settings: 'KEY_TOOLS', play: 'KEY_PLAY',
  pause: 'KEY_PAUSE', play_pause: 'KEY_PLAY_BACK', stop: 'KEY_STOP', rewind: 'KEY_REWIND', forward: 'KEY_FF',
  red: 'KEY_RED', green: 'KEY_GREEN', yellow: 'KEY_YELLOW', blue: 'KEY_CYAN',
};
for (let i = 0; i <= 9; i++) MAP[String(i)] = `KEY_${i}`;

const APPS = { youtube: '111299001912', netflix: '3201907018807', 'prime video': '3201910019365', 'disney+': '3201901017640', spotify: '3201606009684' };

class SamsungDriver {
  constructor(device, emit) {
    this.device = device;
    this.emit = emit;
  }

  static get type() { return 'samsung'; }
  static get needs() { return []; }

  connect() {
    const name = Buffer.from('RemoteTV').toString('base64');
    const token = this.device.token ? `&token=${this.device.token}` : '';
    const url = `wss://${this.device.host}:8002/api/v2/channels/samsung.remote.control?name=${name}${token}`;
    this.emit('pairing', { message: 'Press "Allow" on your Samsung TV', noCode: true });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('Samsung TV did not accept the connection')), 40000);
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.event === 'ms.channel.connect') {
          clearTimeout(timer);
          if (m.data?.token) this.emit('persist', { token: m.data.token });
          this.emit('state', { connected: true, power: true });
          resolve(true);
        } else if (m.event === 'ms.channel.unauthorized') {
          clearTimeout(timer); reject(new Error('Connection denied on the TV'));
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => this.emit('state', { connected: false }));
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  supportedKeys() { return Object.keys(MAP); }

  async sendKey(key, mode = 'short') {
    const k = MAP[key];
    if (!k) throw new Error(`Samsung: key "${key}" not supported`);
    const Cmd = mode === 'start' ? 'Press' : mode === 'end' ? 'Release' : 'Click';
    this.send({ method: 'ms.remote.control', params: { Cmd, DataOfCmd: k, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  }

  async sendText(text) {
    this.send({ method: 'ms.remote.control', params: { Cmd: Buffer.from(text).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } });
    this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  async move(dx, dy) {
    this.send({ method: 'ms.remote.control', params: { Cmd: 'Move', Position: { x: dx, y: dy, Time: String(Date.now()) }, TypeOfRemote: 'ProcessMouseDevice' } });
  }

  async listApps() { return Object.entries(APPS).map(([name, id]) => ({ id, name })); }

  async launchApp(id, metaTag) {
    const appId = APPS[String(id).toLowerCase()] || id;
    this.send({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId, action_type: 'DEEP_LINK', metaTag } } });
  }

  async castYouTube(videoId) { await this.launchApp('youtube', `v=${videoId}`); }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

module.exports = SamsungDriver;
