// server.properties reader/writer - comment line gulo safe thake
const fs = require('fs');
const path = require('path');

function propsPath(serversDir, id) {
  return path.join(path.resolve(serversDir), id, 'server.properties');
}

function readRaw(serversDir, id) {
  const f = propsPath(serversDir, id);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split(/\r?\n/);
}

// lines -> [{comment}|{key,value}] protocol order rakhe
function parse(lines) {
  const entries = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { entries.push({ comment: line }); continue; }
    const i = line.indexOf('=');
    if (i < 0) { entries.push({ comment: line }); continue; }
    entries.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1) });
  }
  return entries;
}

// kv ar moddhe jeshob key set hoiSe seta replace, baki notun append
function setValues(entries, kv) {
  const rest = { ...kv };
  for (const e of entries) {
    if (e.comment || e.key == null) continue;
    if (Object.prototype.hasOwnProperty.call(rest, e.key)) {
      e.value = String(rest[e.key]);
      delete rest[e.key];
    }
  }
  for (const [k, v] of Object.entries(rest)) entries.push({ key: k, value: String(v) });
  return entries.map(e => (e.comment ? e.comment : `${e.key}=${e.value ?? ''}`));
}

function write(serversDir, id, lines) {
  const dir = path.dirname(propsPath(serversDir, id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(propsPath(serversDir, id), lines.join('\n') + '\n');
  return { ok: true };
}

function getPort(serversDir, id, fallback = 25565) {
  try {
    const raw = readRaw(serversDir, id);
    if (!raw) return null;
    for (const e of parse(raw)) if (e.key === 'server-port') return parseInt(e.value) || fallback;
    return fallback;
  } catch { return fallback; }
}

module.exports = { propsPath, readRaw, parse, setValues, write, getPort };
