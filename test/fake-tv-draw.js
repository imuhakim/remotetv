'use strict';
// Fake "RemoteTV on the TV" web drawing server (port 7334 API), for trying
// public/tvdraw.html in a browser without a TV. Mirrors HelperService.api():
//   node test/fake-tv-draw.js [port]   then open http://localhost:<port>
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createFakeTv() {
  const tv = { code: null, tries: 0, tokens: new Set(), ops: [], overlay: true };
  tv.server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'tvdraw.html')));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body || '{}'); } catch { /* empty */ }
      const name = req.url.replace(/^\/api\//, '');
      const valid = tv.tokens.has(m.token);
      if (name === 'hello') {
        if (!valid && tv.overlay) { tv.code = String(crypto.randomInt(1e6)).padStart(6, '0'); tv.tries = 0; console.log('TV shows code', tv.code); }
        return send(200, { ok: true, paired: valid, overlay: tv.overlay, w: 1920, h: 1080 });
      }
      if (name === 'pair') {
        const ok = tv.code && tv.tries < 5 && String(m.code).trim() === tv.code;
        tv.tries++;
        if (!ok) return send(403, { ok: false, error: tv.tries >= 5 ? 'Too many tries. Connect again for a new code.' : 'Wrong code' });
        const token = crypto.randomBytes(16).toString('hex');
        tv.tokens.add(token);
        tv.code = null;
        return send(200, { ok: true, token });
      }
      if (name === 'ops') {
        if (!valid) return send(403, { ok: false, error: 'Not paired' });
        for (const op of (m.ops || []).slice(0, 300)) tv.ops.push(op);
        return send(200, { ok: true });
      }
      send(404, { ok: false, error: 'Unknown request' });
    });
  });
  return tv;
}

module.exports = { createFakeTv };
if (require.main === module) {
  const tv = createFakeTv();
  tv.server.listen(Number(process.argv[2]) || 7334, () => console.log('Fake TV drawing page on', tv.server.address().port));
}
