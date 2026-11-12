'use strict';
/* Link to RemoteTV running on the TV (android/app/.../tv/HelperService) on TCP 7333: one JSON
 * object per line. Requests carry "rid" and get a reply with the same rid;
 * drawing operations are fire-and-forget so strokes stay fast. */
(function () {
  const { RemoteTv, net } = window.NativeTv;
  const { listenSockets, sockets, u8ToB64 } = net;
  const PORT = 7333;
  const enc = new TextEncoder();

  const NOT_RUNNING = 'RemoteTV is not running on this TV yet. Install it on the TV first (More › Draw on TV shows how).';

  class HelperLink {
    constructor(host, port = PORT) {
      this.host = host; this.port = port; this.buf = ''; this.pending = new Map(); this.rid = 1; this.closed = false;
      this.decoder = new TextDecoder();
    }
    async open() {
      await listenSockets();
      const r = await RemoteTv.tcpConnect({ host: this.host, port: this.port, timeoutMs: 4000 })
        .catch((e) => { throw new Error(/Connect failed|refused|timed out/i.test(e.message) ? NOT_RUNNING : e.message); });
      this.id = r.id;
      sockets.set(r.id, this);
      return this;
    }
    onData(chunk) {
      this.buf += this.decoder.decode(chunk, { stream: true });
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const cb = this.pending.get(m.rid);
        if (cb) { this.pending.delete(m.rid); cb(m); }
      }
    }
    onClose() {
      this.closed = true;
      for (const cb of this.pending.values()) cb({ ok: false, error: 'The connection to the TV helper closed' });
      this.pending.clear();
    }
    request(msg, timeoutMs = 6000) {
      const rid = this.rid++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.pending.delete(rid); reject(new Error('The TV helper did not answer')); }, timeoutMs);
        this.pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
        this.write([{ ...msg, rid }]).catch((e) => { clearTimeout(t); this.pending.delete(rid); reject(e); });
      });
    }
    write(msgs) {
      if (this.closed) return Promise.reject(new Error('The connection to the TV helper closed'));
      const text = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
      return RemoteTv.tlsWrite({ id: this.id, data: u8ToB64(enc.encode(text)) });
    }
    close() { this.closed = true; return RemoteTv.tlsClose({ id: this.id }).catch(() => {}); }
  }

  window.NativeHelper = { HelperLink, PORT, NOT_RUNNING };
})();
