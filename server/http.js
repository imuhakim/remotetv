'use strict';
// Tiny fetch wrapper with a timeout, shared by the HTTP-based drivers.
async function request(url, { method = 'GET', headers = {}, body, timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, headers: res.headers, text };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout calling ${url}`);
    throw new Error(`Cannot reach ${url}: ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(t);
  }
}

function xmlTag(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

module.exports = { request, xmlTag, xmlEscape };
