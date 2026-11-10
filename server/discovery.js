'use strict';
// LAN discovery: SSDP (Sony, Roku, LG, Samsung, any DLNA renderer / DIAL
// device) plus mDNS (_androidtvremote2._tcp for Android/Google TV).
const dgram = require('dgram');
const { Bonjour } = require('bonjour-service');
const { request, xmlTag } = require('./http');

const TARGETS = [
  'urn:schemas-sony-com:service:ScalarWebAPI:1',
  'roku:ecp',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:dial-multiscreen-org:service:dial:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
];

function classify(st, desc) {
  const s = `${st} ${desc.manufacturer} ${desc.modelName}`.toLowerCase();
  if (st.includes('roku') || s.includes('roku')) return 'roku';
  if (st.includes('sony') || s.includes('sony')) return 'sony';
  if (st.includes('lge') || s.includes('lg electronics')) return 'lg';
  if (st.includes('samsung') || s.includes('samsung')) return 'samsung';
  return 'dlna';
}

function ssdp(timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map(); // location -> st
    sock.on('message', (msg) => {
      const text = msg.toString();
      const loc = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim();
      const st = /^st:\s*(.+)$/im.exec(text)?.[1]?.trim() || '';
      if (loc && (!found.has(loc) || st.includes('sony') || st.includes('roku'))) found.set(loc, st);
    });
    sock.on('error', () => resolve(found));
    sock.bind(0, () => {
      for (const st of TARGETS) {
        const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(m, 1900, '239.255.255.250');
      }
    });
    setTimeout(() => { try { sock.close(); } catch { /* */ } resolve(found); }, timeoutMs);
  });
}

async function describe(location, st) {
  const url = new URL(location);
  const out = { host: url.hostname, location, st };
  try {
    const r = await request(location, { timeout: 2500 });
    out.name = xmlTag(r.text, 'friendlyName');
    out.manufacturer = xmlTag(r.text, 'manufacturer') || '';
    out.modelName = xmlTag(r.text, 'modelName') || '';
    out.dialUrl = r.headers.get('application-url') || null;
    out.hasAVTransport = /AVTransport/i.test(r.text);
  } catch { /* unreachable description, keep basic info */ }
  out.type = classify(st, out);
  if (out.type === 'roku') out.port = Number(url.port) || 8060;
  return out;
}

function mdns(timeoutMs) {
  return new Promise((resolve) => {
    const list = [];
    let bonjour;
    try { bonjour = new Bonjour(); } catch { return resolve(list); }
    const browser = bonjour.find({ type: 'androidtvremote2' }, (svc) => {
      const host = svc.addresses?.find((a) => a.includes('.')) || svc.host;
      list.push({ host, name: svc.name, type: 'androidtv', manufacturer: '', modelName: '' });
    });
    setTimeout(() => { browser.stop(); bonjour.destroy(); resolve(list); }, timeoutMs);
  });
}

// Returns one entry per TV host with every protocol we saw for it, so the UI
// can offer "Sony (REST)" and "Android TV" for the same BRAVIA set.
async function discover(timeoutMs = 3000) {
  const [ssdpHits, mdnsHits] = await Promise.all([ssdp(timeoutMs), mdns(timeoutMs)]);
  const described = await Promise.all([...ssdpHits].map(([loc, st]) => describe(loc, st)));
  const byHost = new Map();
  for (const d of [...described, ...mdnsHits]) {
    const cur = byHost.get(d.host) || { host: d.host, name: d.name, protocols: [], dlna: null, dialUrl: null };
    cur.name = cur.name || d.name;
    cur.modelName = cur.modelName || d.modelName;
    if (d.type !== 'dlna' && !cur.protocols.includes(d.type)) cur.protocols.push(d.type);
    if (d.hasAVTransport) cur.dlna = d.location;
    if (d.dialUrl) cur.dialUrl = d.dialUrl;
    if (d.port) cur.port = d.port;
    byHost.set(d.host, cur);
  }
  return [...byHost.values()].filter((d) => d.protocols.length || d.dlna);
}

module.exports = { discover, describe };
