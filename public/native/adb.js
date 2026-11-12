'use strict';
/* Minimal ADB (Android Debug Bridge) client over the TV's network debugging
 * port (5555), used by the APK's "Advanced (ADB)" mode: screenshots, a live
 * view of the TV screen with touch, app list and TV health.
 *
 * Protocol: 24-byte little-endian header [command, arg0, arg1, length,
 * checksum, magic] + payload. Auth signs the TV's 20-byte token with this
 * app's RSA key; the first time, the TV asks "Allow debugging?" and the user
 * picks "Always allow". */
(function () {
  const { RemoteTv, net } = window.NativeTv;
  const { listenSockets, sockets, u8ToB64, clientIdentity } = net;

  const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257, STLS: 0x534c5453 };
  const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
  const AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
  const VERSION = 0x01000001;
  const MAX_DATA = 256 * 1024;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function packet(cmd, arg0, arg1, data = new Uint8Array(0)) {
    const out = new Uint8Array(24 + data.length);
    const v = new DataView(out.buffer);
    let sum = 0;
    for (const b of data) sum = (sum + b) >>> 0;
    [cmd, arg0, arg1, data.length, sum, (cmd ^ 0xffffffff) >>> 0].forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
    out.set(data, 24);
    return out;
  }

  // ---------------------------------------------------------------- keys
  function privateKey(ident) { return window.forge.pki.privateKeyFromPem(ident.key); }

  // Android's RSAPublicKey struct (mincrypt): len, n0inv, n[], rr[], e — all
  // little-endian 32-bit words — base64-encoded, then " name".
  function androidPublicKey(key, name = 'RemoteTV@phone') {
    const { BigInteger } = window.forge.jsbn;
    const n = key.n;
    const words = 64; // 2048-bit
    const two32 = new BigInteger('100000000', 16);
    const buf = new Uint8Array(4 + 4 + words * 4 * 2 + 4);
    const v = new DataView(buf.buffer);
    v.setUint32(0, words, true);
    const n0 = n.mod(two32);
    const n0inv = two32.subtract(n0.modInverse(two32)).mod(two32);
    v.setUint32(4, Number(n0inv.toString()), true);
    const putWords = (big, off) => {
      let x = big;
      for (let i = 0; i < words; i++) {
        v.setUint32(off + i * 4, Number(x.mod(two32).toString()), true);
        x = x.shiftRight(32);
      }
    };
    putWords(n, 8);
    const rr = BigInteger.ONE.shiftLeft(words * 32 * 2).mod(n);
    putWords(rr, 8 + words * 4);
    v.setUint32(8 + words * 8, Number(key.e.toString()), true);
    return enc.encode(`${u8ToB64(buf)} ${name}\0`);
  }

  // adbd verifies RSA_verify(NID_sha1, token): PKCS#1 v1.5 with the SHA-1
  // DigestInfo prefix over the raw 20-byte token (no hashing).
  function signToken(key, token) {
    const forge = window.forge;
    const md = { algorithm: 'sha1', digest: () => forge.util.createBuffer(String.fromCharCode(...token)) };
    const sig = key.sign(md, 'RSASSA-PKCS1-V1_5');
    return Uint8Array.from(sig, (c) => c.charCodeAt(0));
  }

  // ----------------------------------------------------------- connection
  class Adb {
    constructor(host, port = 5555) {
      this.host = host; this.port = port; this.buf = new Uint8Array(0);
      this.streams = new Map(); this.nextLocal = 1; this.maxData = MAX_DATA; this.closed = false;
    }

    /** Resolves once the TV accepts this phone. onPrompt() fires when the TV is showing "Allow debugging?". */
    async connect({ onPrompt, timeoutMs = 60000 } = {}) {
      const ident = await clientIdentity();
      this.key = privateKey(ident);
      await listenSockets();
      const r = await RemoteTv.tcpConnect({ host: this.host, port: this.port, timeoutMs: 5000 }).catch((e) => {
        throw new Error(/refused|ECONNREFUSED|Connect failed/i.test(e.message)
          ? 'The TV is not accepting ADB. Turn on Developer options › Network debugging (or USB debugging) on the TV.'
          : e.message);
      });
      this.id = r.id;
      sockets.set(r.id, this);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.close(); reject(new Error('The TV did not answer. On the TV choose "Always allow" in the debugging prompt, then try again.')); }, timeoutMs);
        let sentKey = false;
        this.onPacket = (p) => {
          if (p.cmd === CMD.AUTH && p.arg0 === AUTH_TOKEN) {
            if (!this.signed) { this.signed = true; this.write(CMD.AUTH, AUTH_SIGNATURE, 0, signToken(this.key, p.data)); }
            else if (!sentKey) { sentKey = true; this.write(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, androidPublicKey(this.key)); onPrompt?.(); }
          } else if (p.cmd === CMD.CNXN) {
            clearTimeout(timer);
            this.maxData = Math.min(MAX_DATA, p.arg1 || MAX_DATA);
            this.banner = dec.decode(p.data);
            this.onPacket = (q) => this.route(q);
            resolve(this);
          } else if (p.cmd === CMD.STLS) {
            clearTimeout(timer); this.close();
            reject(new Error('This TV uses Android 11+ "Wireless debugging" with pairing, which is not supported yet. Use "Network debugging" on port 5555.'));
          }
        };
        this.failConnect = (err) => { clearTimeout(timer); reject(new Error(`ADB connection closed${err ? `: ${err}` : ''}`)); };
        this.write(CMD.CNXN, VERSION, MAX_DATA, enc.encode('host::\0'));
      });
    }

    write(cmd, a0, a1, data) { return RemoteTv.tlsWrite({ id: this.id, data: u8ToB64(packet(cmd, a0, a1, data)) }); }

    onData(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      this.buf = merged;
      while (this.buf.length >= 24) {
        const v = new DataView(this.buf.buffer, this.buf.byteOffset, 24);
        const len = v.getUint32(12, true);
        if (this.buf.length < 24 + len) return;
        const p = { cmd: v.getUint32(0, true), arg0: v.getUint32(4, true), arg1: v.getUint32(8, true), data: this.buf.slice(24, 24 + len) };
        this.buf = this.buf.slice(24 + len);
        try { this.onPacket?.(p); } catch (e) { console.warn('adb', NAME[p.cmd], e); }
      }
    }

    onClose(err) {
      this.closed = true;
      this.failConnect?.(err);
      for (const s of this.streams.values()) s.done(new Error('ADB connection closed'));
      this.streams.clear();
    }

    route(p) {
      const s = this.streams.get(p.arg1);
      if (!s) { if (p.cmd === CMD.WRTE) this.write(CMD.CLSE, p.arg1, p.arg0); return; }
      if (p.cmd === CMD.OKAY) { s.remote = p.arg0; const f = s.onOkay; s.onOkay = null; f?.(); }
      else if (p.cmd === CMD.WRTE) { s.chunks.push(p.data); s.size += p.data.length; this.write(CMD.OKAY, s.local, p.arg0); }
      else if (p.cmd === CMD.CLSE) {
        this.streams.delete(s.local);
        if (s.remote) this.write(CMD.CLSE, s.local, s.remote);
        s.done();
      }
    }

    /** Runs a service ("exec:cmd" / "shell:cmd") and returns all its output bytes. */
    run(service, opts) { return this.open(service, opts).result; }

    /** Runs a service that reads stdin (e.g. "exec:cmd package install -S n"): writes data, returns the output. */
    async push(service, data, { timeoutMs = 180000 } = {}) {
      const st = this.open(service, { timeoutMs });
      const waitOkay = () => new Promise((res) => { st.stream.onOkay = res; });
      const opened = waitOkay();
      const alive = () => this.streams.has(st.stream.local); // the TV may close early (e.g. install failure)
      await Promise.race([opened, st.result]); // stream opened (or failed)
      for (let off = 0; off < data.length && alive(); off += this.maxData) {
        const chunk = data.subarray(off, Math.min(data.length, off + this.maxData));
        const acked = waitOkay();
        await this.write(CMD.WRTE, st.stream.local, st.stream.remote, chunk);
        await Promise.race([acked, st.result]); // flow control: one packet in flight
      }
      return st.result;
    }

    open(service, { timeoutMs = 20000 } = {}) {
      if (this.closed) return { result: Promise.reject(new Error('ADB is not connected')), stream: {} };
      const local = this.nextLocal++;
      let stream;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.streams.delete(local); reject(new Error('The TV took too long to answer')); }, timeoutMs);
        const s = stream = {
          local, remote: 0, chunks: [], size: 0, onOkay: null,
          done: (err) => {
            clearTimeout(timer);
            if (err) return reject(err);
            const out = new Uint8Array(s.size);
            let o = 0;
            for (const c of s.chunks) { out.set(c, o); o += c.length; }
            resolve(out);
          },
        };
        this.streams.set(local, s);
        this.write(CMD.OPEN, local, 0, enc.encode(`${service}\0`)).catch((e) => { this.streams.delete(local); clearTimeout(timer); reject(e); });
      });
      return { result, stream };
    }

    async sh(cmd, opts) { return dec.decode(await this.run(`exec:${cmd}`, opts)).replace(/\r/g, ''); }

    close() { this.closed = true; return RemoteTv.tlsClose({ id: this.id }).catch(() => {}); }
  }

  // ------------------------------------------------------------ features
  const KEYCODE_SLEEP = 223;
  const pngSize = (b) => {
    if (b.length < 24 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = new DataView(b.buffer, b.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  };
  const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const PKG = /^[\w.]+$/;
  const HELPER_PKG = 'io.github.imuhakim.remotetv'; // the same app runs on the TV as the drawing receiver
  const HELPER_SVC = `${HELPER_PKG}/io.github.imuhakim.remotetv.tv.HelperService`;
  const OLD_HELPER = 'io.github.imuhakim.remotetv.tv'; // separate helper app of v1.1.12

  const features = {
    async screenshot(adb) {
      const png = await adb.run('exec:screencap -p', { timeoutMs: 15000 });
      const size = pngSize(png);
      if (!size) throw new Error(dec.decode(png.slice(0, 200)).trim() || 'The TV did not return a screenshot');
      return { png: u8ToB64(png), ...size };
    },
    async tap(adb, x, y) { await adb.sh(`input tap ${Math.round(x)} ${Math.round(y)}`); },
    async swipe(adb, x1, y1, x2, y2, ms = 250) { await adb.sh(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.round(ms)}`); },
    async text(adb, t) { await adb.sh(`input text ${quote(String(t).replace(/ /g, '%s'))}`); },
    async apps(adb) {
      let out = await adb.sh('cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER').catch(() => '');
      let pkgs = [...out.matchAll(/packageName=([\w.]+)/g)].map((m) => m[1]);
      if (!pkgs.length) {
        out = await adb.sh('pm list packages');
        pkgs = [...out.matchAll(/package:([\w.]+)/g)].map((m) => m[1]);
      }
      const third = new Set([...(await adb.sh('pm list packages -3')).matchAll(/package:([\w.]+)/g)].map((m) => m[1]));
      return [...new Set(pkgs)].sort().map((id) => ({ id, user: third.has(id) }));
    },
    async openApp(adb, pkg) {
      if (!PKG.test(pkg)) throw new Error('Bad package name');
      const out = await adb.sh(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`);
      if (/No activities found/i.test(out)) await adb.sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    },
    async stopApp(adb, pkg) {
      if (!PKG.test(pkg)) throw new Error('Bad package name');
      await adb.sh(`am force-stop ${pkg}`);
    },
    async info(adb) {
      const out = await adb.sh([
        'echo model=$(getprop ro.product.model)', 'echo brand=$(getprop ro.product.manufacturer)', 'echo android=$(getprop ro.build.version.release)',
        'echo uptime=$(cut -d. -f1 /proc/uptime)', "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
        'echo temp=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)', 'df -h /data | tail -n 1',
        "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'",
      ].join('; '));
      const get = (re) => re.exec(out)?.[1];
      const kb = (k) => Number(get(new RegExp(`${k}:\\s+(\\d+)`)) || 0);
      const df = /\S+\s+([\d.]+[KMGT]?)\s+([\d.]+[KMGT]?)\s+([\d.]+[KMGT]?)/.exec(out.split('\n').find((l) => /\/data\s*$/.test(l)) || '');
      const t = Number(get(/temp=(\d+)/));
      return {
        model: get(/model=(.*)/), brand: get(/brand=(.*)/), android: get(/android=(.*)/), uptimeSec: Number(get(/uptime=(\d+)/) || 0),
        memTotalMb: Math.round(kb('MemTotal') / 1024), memFreeMb: Math.round(kb('MemAvailable') / 1024),
        storage: df ? { size: df[1], used: df[2], free: df[3] } : null,
        tempC: t ? (t > 1000 ? t / 1000 : t) : null,
        topApp: get(/ ([\w.]+)\/[\w.$]+/),
      };
    },
    // Installs RemoteTV on the TV, allows it to draw over other apps and starts the receiver.
    async installHelper(adb, apk) {
      await adb.sh(`pm uninstall ${OLD_HELPER} 2>/dev/null`).catch(() => {}); // it would hold port 7333
      let out = dec.decode(await adb.push(`exec:cmd package install -r -S ${apk.length}`, apk)).trim();
      if (!/Success/.test(out)) out = dec.decode(await adb.push(`exec:pm install -r -S ${apk.length}`, apk)).trim();
      if (!/Success/.test(out)) throw new Error(`The TV refused the install: ${out.slice(0, 160) || 'no answer'}`);
      await adb.sh(`appops set ${HELPER_PKG} SYSTEM_ALERT_WINDOW allow`);
      const started = await adb.sh(`am start-foreground-service -n ${HELPER_SVC} 2>&1 || am startservice -n ${HELPER_SVC} 2>&1`);
      return { installed: true, started: !/Error|not found/i.test(started) };
    },
    async helperState(adb) {
      const out = await adb.sh(`pm list packages ${HELPER_PKG}; appops get ${HELPER_PKG} SYSTEM_ALERT_WINDOW 2>/dev/null`);
      return { installed: out.includes(`package:${HELPER_PKG}`), overlay: /allow/i.test(out) };
    },
    // Sleep timer that runs on the TV itself (the phone can be switched off).
    async sleepTimer(adb, minutes) {
      await adb.sh('kill $(cat /data/local/tmp/rtv_sleep 2>/dev/null) 2>/dev/null; rm -f /data/local/tmp/rtv_sleep');
      if (!minutes) return;
      const secs = Math.max(60, Math.min(24 * 3600, Math.round(minutes * 60)));
      await adb.sh(`nohup sh -c 'echo $$ > /data/local/tmp/rtv_sleep; sleep ${secs}; rm -f /data/local/tmp/rtv_sleep; input keyevent ${KEYCODE_SLEEP}' >/dev/null 2>&1 &`);
    },
  };

  window.NativeAdb = { Adb, features, androidPublicKey, signToken, packet, CMD };
})();
