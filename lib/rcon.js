// Minimal Minecraft RCON client (no npm deps) — protocol v1
// packet: [len i32LE][id i32LE][type i32LE][body utf8][00 00]
// types: 3 = auth request, 2 = auth response + command request, 0 = command response
const net = require('net');

function packet(id, type, body) {
  const b = Buffer.from(String(body == null ? '' : body), 'utf8');
  const buf = Buffer.alloc(12 + b.length + 2);
  buf.writeInt32LE(4 + 4 + b.length + 2, 0);
  buf.writeInt32LE(id | 0, 4);
  buf.writeInt32LE(type | 0, 8);
  b.copy(buf, 12);
  return buf;
}

// ek connection e cmds sequentially run kore → output[] (best-effort — timeout e jototuku peyechi)
// multi-packet response: sentinel echo (server dhore) + idle-gap fallback (na dhore)
function run(host, port, password, cmds, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let done = false, authed = false, buf = Buffer.alloc(0);
    const results = [];
    let cur = null, idleT = null, firstT = null;

    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const totalT = setTimeout(() => finish(null, results), timeoutMs);

    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(totalT); clearTimeout(idleT); clearTimeout(firstT);
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve(val);
    }
    function cmdDone() {
      if (done || !cur) return;
      clearTimeout(idleT); clearTimeout(firstT);
      results.push(cur.chunks.join(''));
      cur = null;
      next();
    }
    function next() {
      if (done) return;
      if (results.length >= cmds.length) return finish(null, results);
      const i = results.length;
      cur = { id: 1000 + i * 2, sentinel: 1001 + i * 2, chunks: [] };
      sock.write(packet(cur.id, 2, cmds[i]));
      sock.write(packet(cur.sentinel, 0, ''));   // finish marker — server echo korle sathe sathe bujhbo
      firstT = setTimeout(cmdDone, 1500);        // kono packet na ele (empty output) — best-effort finish
    }
    function onPkt(id, type, body) {
      if (!authed) {
        authed = true;
        if (id === -1) return finish(new Error('rcon password vul'));
        return next();
      }
      if (!cur) return;
      if (id === cur.sentinel) return cmdDone();
      if (id !== cur.id) return;
      cur.chunks.push(body);
      clearTimeout(firstT);
      clearTimeout(idleT);
      idleT = setTimeout(cmdDone, 250);          // sentinel na ashle idle-gap e finish
    }

    sock.on('connect', () => sock.write(packet(1, 3, password)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (len < 10 || len > 8 * 1024 * 1024) return finish(new Error('rcon protocol garbled'));
        if (buf.length < 4 + len) break;
        const p = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        onPkt(p.readInt32LE(0), p.readInt32LE(4), p.slice(8, p.length - 2).toString('utf8'));
      }
    });
    sock.on('error', e => finish(new Error(e.code === 'ECONNREFUSED'
      ? 'rcon connect fail — port bind hoy nai (server bondho ba rcon off)'
      : ('rcon ' + e.message))));
    sock.on('close', () => {
      if (done) return;
      if (!authed) return finish(new Error('rcon closed (auth er age)'));
      finish(null, results);                     // mid-way close — ja peyechi tai dilam
    });
  });
}

module.exports = { run, packet };
