'use strict';
// Wake-on-LAN magic packet (TV must have "Remote start" / "Wake on LAN" on).
const dgram = require('dgram');

function wake(mac, broadcast = '255.255.255.255') {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error('Invalid MAC address'));
  const m = Buffer.from(hex, 'hex');
  const pkt = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(pkt, 6 + i * 6);
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.bind(() => {
      s.setBroadcast(true);
      let n = 0;
      const fire = () => s.send(pkt, 9, broadcast, (err) => {
        if (err) { s.close(); return reject(err); }
        if (++n < 3) setTimeout(fire, 100); else { s.close(); resolve(); }
      });
      fire();
    });
  });
}

module.exports = { wake };
