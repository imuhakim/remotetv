'use strict';
// Casting without any vendor SDK:
//  * DLNA/UPnP AVTransport — push a photo/video/audio URL to the TV's
//    built-in media renderer (Sony BRAVIA, LG, Samsung, most smart TVs).
//  * DIAL — ask the TV's YouTube app to open a specific video.
const { request, xmlTag, xmlEscape } = require('./http');

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

async function findService(location, serviceType) {
  const r = await request(location);
  const blocks = r.text.split(/<service>/i).slice(1);
  for (const b of blocks) {
    if (xmlTag(b, 'serviceType') === serviceType) {
      return new URL(xmlTag(b, 'controlURL'), location).toString();
    }
  }
  throw new Error(`TV does not expose ${serviceType.split(':')[3]}`);
}

async function soap(controlUrl, serviceType, action, args) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await request(controlUrl, {
    method: 'POST', body, timeout: 8000,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${serviceType}#${action}"` },
  });
  if (!r.ok) throw new Error(`${action} failed (${r.status}): ${xmlTag(r.text, 'errorDescription') || ''}`);
  return r.text;
}

function didl(url, mime, title) {
  const cls = mime.startsWith('image/') ? 'object.item.imageItem.photo'
    : mime.startsWith('audio/') ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${xmlEscape(title)}</dc:title><upnp:class>${cls}</upnp:class><res protocolInfo="http-get:*:${mime}:*">${xmlEscape(url)}</res></item></DIDL-Lite>`;
}

const cache = new Map();
async function avt(location) {
  if (!cache.has(location)) cache.set(location, await findService(location, AVT));
  return cache.get(location);
}

async function play(location, url, mime = 'video/mp4', title = 'RemoteTV') {
  const ctl = await avt(location);
  await soap(ctl, AVT, 'Stop', { InstanceID: 0 }).catch(() => {});
  await soap(ctl, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl(url, mime, title) });
  await soap(ctl, AVT, 'Play', { InstanceID: 0, Speed: 1 });
}

async function control(location, action, value) {
  const ctl = await avt(location);
  if (action === 'pause') return soap(ctl, AVT, 'Pause', { InstanceID: 0 });
  if (action === 'resume') return soap(ctl, AVT, 'Play', { InstanceID: 0, Speed: 1 });
  if (action === 'stop') return soap(ctl, AVT, 'Stop', { InstanceID: 0 });
  if (action === 'seek') return soap(ctl, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: value });
  if (action === 'volume') {
    const rc = await findService(location, RC);
    return soap(rc, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: value });
  }
  throw new Error(`Unknown cast action ${action}`);
}

async function status(location) {
  const ctl = await avt(location);
  const [t, p] = await Promise.all([
    soap(ctl, AVT, 'GetTransportInfo', { InstanceID: 0 }),
    soap(ctl, AVT, 'GetPositionInfo', { InstanceID: 0 }),
  ]);
  return {
    state: xmlTag(t, 'CurrentTransportState'),
    position: xmlTag(p, 'RelTime'),
    duration: xmlTag(p, 'TrackDuration'),
  };
}

// DIAL: POST <Application-URL>/YouTube with body "v=<id>".
async function dialYouTube(dialUrl, videoId) {
  const base = dialUrl.endsWith('/') ? dialUrl : dialUrl + '/';
  const r = await request(`${base}YouTube`, {
    method: 'POST', body: `v=${encodeURIComponent(videoId)}`,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  if (!(r.status === 201 || r.ok)) throw new Error(`DIAL YouTube launch failed (${r.status})`);
}

function youtubeId(input) {
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(s);
  if (!m) throw new Error('Not a YouTube link');
  return m[1];
}

module.exports = { play, control, status, dialYouTube, youtubeId, didl };
