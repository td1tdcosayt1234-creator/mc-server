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

// lines -> [{comment,isComment:true}|{key,value}] protocol order rakhe
// comment flag alada — blank line er comment '' falsy, tai age `e.comment ?` check e
// blank line "undefined=" hoye jeto (property file corrupt hoye jay)
function parse(lines) {
  const entries = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { entries.push({ comment: line, isComment: true }); continue; }
    const i = line.indexOf('=');
    if (i < 0) { entries.push({ comment: line, isComment: true }); continue; }
    entries.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1), isComment: false });
  }
  return entries;
}

// kv ar moddhe jeshob key set hoiSe seta replace, baki notun append
function setValues(entries, kv) {
  const rest = { ...kv };
  for (const e of entries) {
    if (e.isComment || e.key == null) continue;
    if (Object.prototype.hasOwnProperty.call(rest, e.key)) {
      // value e newline thakle notun property line dhuroke jay — ek line e rakho
      e.value = String(rest[e.key]).replace(/[\r\n]+/g, ' ');
      delete rest[e.key];
    }
  }
  for (const [k, v] of Object.entries(rest)) entries.push({ key: k, value: String(v).replace(/[\r\n]+/g, ' '), isComment: false });
  return entries.map(e => (e.isComment ? e.comment : `${e.key}=${e.value ?? ''}`));
}

function write(serversDir, id, lines) {
  const dir = path.dirname(propsPath(serversDir, id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // atomic write — tmp e likhe rename (truncate+write e crash korle file empty/half hoye jay,
  // server default properties e chole jay → wrong world)
  const target = propsPath(serversDir, id);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  try { fs.renameSync(tmp, target); }
  catch { try { fs.copyFileSync(tmp, target); fs.rmSync(tmp, { force: true }); } catch {} }
  return { ok: true };
}

function getPort(serversDir, id, fallback = 25565) {
  try {
    const raw = readRaw(serversDir, id);
    if (!raw) return null;
    // duplicate key thakle LAST ta win kore (java Properties.load er moto) — age FIRST ta
    // nilo → port conflict guard bhul port compare korto
    let port = null;
    for (const e of parse(raw)) if (e.key === 'server-port') port = parseInt(e.value) || null;
    return port || fallback;
  } catch { return fallback; }
}

module.exports = { propsPath, readRaw, parse, setValues, write, getPort };
