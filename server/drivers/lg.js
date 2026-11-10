'use strict';
// LG webOS driver: SSAP over WebSocket (wss://:3001, falls back to ws://:3000).
// First connection shows an "Allow?" prompt on the TV; the client-key is saved.
// Protocol as documented by https://github.com/hobbyquaker/lgtv2
const WebSocket = require('ws');

const PERMISSIONS = [
  'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER',
  'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE',
  'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_INSTALLED_APPS',
  'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_POWER_STATE', 'READ_COUNTRY_INFO',
];

// Keys sent on the pointer-input socket.
const BUTTONS = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'ENTER', back: 'BACK', home: 'HOME',
  menu: 'MENU', info: 'INFO', guide: 'GUIDE', red: 'RED', green: 'GREEN', yellow: 'YELLOW', blue: 'BLUE',
  ch_up: 'CHANNELUP', ch_down: 'CHANNELDOWN', vol_up: 'VOLUMEUP', vol_down: 'VOLUMEDOWN', mute: 'MUTE',
  play: 'PLAY', pause: 'PAUSE', stop: 'STOP', rewind: 'REWIND', forward: 'FASTFORWARD', settings: 'QMENU',
  input: 'EXIT',
};
for (let i = 0; i <= 9; i++) BUTTONS[String(i)] = String(i);

class LgDriver {
  constructor(device, emit) {
    this.device = device;
    this.emit = emit;
    this.seq = 0;
    this.pending = new Map();
  }

  static get type() { return 'lg'; }
  static get needs() { return []; }

  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  async connect() {
    try { this.ws = await this.open(`wss://${this.device.host}:3001`); }
    catch { this.ws = await this.open(`ws://${this.device.host}:3000`); }
    this.ws.on('message', (m) => this.onMessage(m));
    this.ws.on('close', () => this.emit('state', { connected: false }));
    const payload = {
      forcePairing: false, pairingType: 'PROMPT', 'client-key': this.device.clientKey,
      manifest: { manifestVersion: 1, appVersion: '1.0', permissions: PERMISSIONS,
        signed: { appId: 'com.remotetv.hub', vendorId: 'com.remotetv', created: '20261110', localizedAppNames: { '': 'RemoteTV' }, localizedVendorNames: { '': 'RemoteTV' }, permissions: PERMISSIONS, serial: 'remotetv' },
        signatures: [{ signatureVersion: 1, signature: '' }] },
    };
    this.emit('pairing', { message: 'Accept the RemoteTV prompt on your LG TV', noCode: true });
    const res = await this.call(null, payload, 'register', 60000);
    this.emit('persist', { clientKey: res['client-key'] });
    this.emit('state', { connected: true, power: true });
    const sock = await this.call('ssap://com.webos.service.networkinput/getPointerInputSocket');
    this.pointer = await this.open(sock.socketPath);
    return true;
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'error') { this.pending.delete(msg.id); p.reject(new Error(msg.error)); }
    else if (msg.type === 'registered' || msg.type === 'response') {
      if (msg.payload?.pairingType === 'PROMPT' && msg.type === 'response') return; // waiting for user
      this.pending.delete(msg.id); p.resolve(msg.payload || {});
    }
  }

  call(uri, payload = {}, type = 'request', timeout = 5000) {
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, uri: uri || undefined, payload }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`LG ${uri || type} timed out`)); }, timeout);
    });
  }

  supportedKeys() { return [...Object.keys(BUTTONS), 'power', 'power_off', 'play_pause']; }

  async sendKey(key) {
    if (key === 'power' || key === 'power_off') return this.call('ssap://system/turnOff');
    if (key === 'play_pause') key = (this.paused = !this.paused) ? 'pause' : 'play';
    const b = BUTTONS[key];
    if (!b) throw new Error(`LG: key "${key}" not supported`);
    this.pointer.send(`type:button\nname:${b}\n\n`);
  }

  async move(dx, dy) { this.pointer?.send(`type:move\ndx:${dx}\ndy:${dy}\ndown:0\n\n`); }
  async click() { this.pointer?.send('type:click\n\n'); }

  async setVolume(level) { await this.call('ssap://audio/setVolume', { volume: Number(level) }); }
  async sendText(text) { await this.call('ssap://com.webos.service.ime/insertText', { text, replace: 0 }); }

  async listApps() {
    const r = await this.call('ssap://com.webos.applicationManager/listLaunchPoints');
    return (r.launchPoints || []).map((a) => ({ id: a.id, name: a.title, icon: a.icon }));
  }

  async launchApp(id, params) {
    let appId = id;
    if (!id.includes('.')) {
      const hit = (await this.listApps()).find((a) => a.name.toLowerCase().includes(id.toLowerCase()));
      if (hit) appId = hit.id;
    }
    await this.call('ssap://system.launcher/launch', { id: appId, params });
  }

  async openUrl(url) { await this.call('ssap://system.launcher/open', { target: url }); }
  async castYouTube(videoId) { await this.launchApp('youtube.leanback.v4', { contentTarget: `https://www.youtube.com/tv?v=${videoId}` }); }

  close() { try { this.pointer?.close(); this.ws?.close(); } catch { /* ignore */ } }
}

module.exports = LgDriver;
