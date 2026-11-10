'use strict';
// Persists saved TVs and settings to data/store.json (git-ignored: it holds
// pairing certificates, PSKs and tokens).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.REMOTETV_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'store.json');
fs.mkdirSync(DIR, { recursive: true });

let data = { devices: [], lastDeviceId: null };
try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

const SECRET_FIELDS = ['cert', 'psk', 'clientKey', 'token'];
function publicView(d) {
  const out = { ...d };
  for (const f of SECRET_FIELDS) if (out[f]) out[f] = f === 'psk' ? '••••' : true;
  return out;
}

module.exports = {
  DIR,
  list: () => data.devices,
  get: (id) => data.devices.find((d) => d.id === id),
  add(dev) {
    const existing = data.devices.find((d) => d.host === dev.host && d.type === dev.type);
    if (existing) { Object.assign(existing, dev, { id: existing.id }); save(); return existing; }
    const d = { id: crypto.randomUUID().slice(0, 8), addedAt: Date.now(), ...dev };
    data.devices.push(d);
    save();
    return d;
  },
  update(id, patch) {
    const d = data.devices.find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, patch);
    save();
    return d;
  },
  remove(id) { data.devices = data.devices.filter((d) => d.id !== id); save(); },
  get lastDeviceId() { return data.lastDeviceId; },
  set lastDeviceId(v) { data.lastDeviceId = v; save(); },
  publicView,
};
