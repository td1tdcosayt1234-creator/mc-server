// File Manager - server folder er moddhe safe file operations
const fs = require('fs');
const path = require('path');

const MAX_EDIT = 5 * 1024 * 1024; // editor limit 5MB

// rel er bhitor thakle server folder er baire jete parbe na
function resolveIn(serversDir, id, rel) {
  const root = path.join(path.resolve(serversDir), id);
  const p = path.resolve(root, rel || '');
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('forbidden path');
  return { root, p };
}

function list(serversDir, id, rel = '') {
  const { root, p } = resolveIn(serversDir, id, rel);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  const entries = fs.readdirSync(p, { withFileTypes: true }).map(d => {
    try {
      const st = fs.statSync(path.join(p, d.name));
      return { name: d.name, dir: d.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch { return null; }
  }).filter(Boolean);
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
  const cwd = rel ? String(rel).replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '') : '';
  return { cwd, entries };
}

function read(serversDir, id, rel) {
  const { p } = resolveIn(serversDir, id, rel);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('eta folder, file na');
  if (st.size > MAX_EDIT) throw new Error('file onek boro (edit limit 5MB) - download kore dekho');
  const bytes = fs.readFileSync(p);
  const isText = !bytes.slice(0, 8000).includes(0); // null byte hole binary
  return { path: String(rel).replace(/\\/g, '/'), size: st.size, text: isText, content: isText ? bytes.toString('utf8') : null };
}

function write(serversDir, id, rel, content) {
  const { p } = resolveIn(serversDir, id, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content == null ? '' : String(content));
  return { ok: true };
}

function mkdir(serversDir, id, rel) {
  const { p } = resolveIn(serversDir, id, rel);
  fs.mkdirSync(p, { recursive: true });
  return { ok: true };
}

function remove(serversDir, id, rel) {
  const { root, p } = resolveIn(serversDir, id, rel);
  if (p === root) throw new Error('root folder delete kora jai na');
  fs.rmSync(p, { recursive: true, force: true });
  return { ok: true };
}

function rename(serversDir, id, rel, to) {
  const { p } = resolveIn(serversDir, id, rel);
  const { p: toP } = resolveIn(serversDir, id, to);
  fs.mkdirSync(path.dirname(toP), { recursive: true });
  fs.renameSync(p, toP);
  return { ok: true };
}

function upload(serversDir, id, rel, buffer) {
  const { p } = resolveIn(serversDir, id, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buffer);
  return { ok: true, size: buffer.length };
}

module.exports = { list, read, write, mkdir, remove, rename, upload, MAX_EDIT };
