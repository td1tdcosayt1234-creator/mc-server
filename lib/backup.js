const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const archiver = require('archiver');
const cron = require('node-cron');

const BACKUPS_DIR = path.resolve(process.env.BACKUPS_DIR || './backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const KEEP = 10; // per-server koto backup rakhbo

let drive = null;
try {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT || './serviceAccount.json';
  if (fs.existsSync(saPath) && process.env.DRIVE_FOLDER_ID) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: path.resolve(saPath), scopes: ['https://www.googleapis.com/auth/drive.file'] });
    drive = google.drive({ version: 'v3', auth });
    console.log('[Backup] Google Drive connected');
  } else {
    console.log('[Backup] DRIVE_FOLDER_ID/serviceAccount nai -> local ./backups e backup hobe');
  }
} catch (e) { console.log('[Backup] Drive fail:', e.message); }

// running server er world file gulo Windows e lock thake (EBUSY) — tai age
// per-file retry diye staging folder e copy, tarpor staging zip kora jay
async function stageCopy(srcDir, tmpDir) {
  const q = [{ from: srcDir, to: tmpDir, rel: '' }];
  const skipped = [];
  while (q.length) {
    const { from, to, rel } = q.shift();
    let entries;
    try { entries = fs.readdirSync(from, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const fFrom = path.join(from, ent.name);
      const fTo = path.join(to, ent.name);
      const relName = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        try { fs.mkdirSync(fTo, { recursive: true }); } catch { }
        q.push({ from: fFrom, to: fTo, rel: relName });
      } else if (ent.isFile()) {
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++) {           // EBUSY hole choto wait kore retry
          try { fs.copyFileSync(fFrom, fTo); ok = true; }
          catch (e) { await new Promise(r => setTimeout(r, 400 * (i + 1))); }
        }
        if (!ok) skipped.push(relName);
      }
    }
  }
  return skipped;
}

async function zipFolder(srcDir, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(outZip));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

function validName(id, name) {
  if (!name || !name.startsWith(id + '-') || !name.endsWith('.zip')) throw new Error('notun backup file');
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('notun backup file');
  const p = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(p)) throw new Error('backup nai');
  return p;
}

function listBackups(id) {
  try {
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith(id + '-') && f.endsWith('.zip'))
      .map(f => {
        try {
          const st = fs.statSync(path.join(BACKUPS_DIR, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

async function backupServer(id, serversDir) {
  const src = path.join(path.resolve(serversDir), id);
  if (!fs.existsSync(src)) throw new Error('server folder nai');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `${id}-${stamp}.zip`;
  const zipPath = path.join(BACKUPS_DIR, zipName);
  // running server er file-lock safe: staging copy → zip → staging clean
  const tmp = path.join(os.tmpdir(), 'mcp-bak-' + id + '-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  let skipped = [];
  try {
    skipped = await stageCopy(src, tmp);
    try {
      await zipFolder(tmp, zipPath);
    } catch (e) {
      try { fs.unlinkSync(zipPath); } catch { }
      throw e;
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
  if (skipped.length) console.log(`[Backup] ${id}: ${skipped.length} file lock-er karon e skip holo (baki sob zip e ache)`);

  if (drive) {
    const fileMeta = { name: zipName, parents: [process.env.DRIVE_FOLDER_ID] };
    await drive.files.create({ requestBody: fileMeta, media: { mimeType: 'application/zip', body: fs.createReadStream(zipPath) } });
    console.log(`[Backup] ${id} -> Drive uploaded`);
  } else {
    console.log(`[Backup] ${id} -> local ${zipName}`);
  }
  const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith(id)).sort();
  while (files.length > KEEP) { const f = files.shift(); try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch {} }
  return zipName;
}

function deleteBackup(id, name) {
  fs.unlinkSync(validName(id, name));
  return { ok: true };
}

// backup unzip kore server folder e overwrite (server age stop koro)
async function restoreBackup(id, name, serversDir) {
  const zip = validName(id, name);
  const target = path.join(path.resolve(serversDir), id);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    await new Promise((res, rej) =>
      exec(`powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${target}' -Force"`,
        { timeout: 10 * 60 * 1000 }, e => e ? rej(new Error('unzip fail: ' + e.message)) : res()));
  } else {
    await new Promise((res, rej) =>
      exec(`unzip -o '${zip}' -d '${target}'`, { timeout: 10 * 60 * 1000 }, e => e ? rej(new Error('unzip fail: ' + e.message)) : res()));
  }
  return { ok: true };
}

function startScheduler(getServerIds, serversDir) {
  const mins = Math.max(1, parseInt(process.env.BACKUP_MINUTES || '50', 10));
  const expr = `*/${mins} * * * *`;
  console.log(`[Backup] Auto backup proti ${mins} min por por`);
  cron.schedule(expr, async () => {
    try {
      const ids = await getServerIds();
      for (const id of ids) {
        try { await backupServer(id, serversDir); } catch (e) { console.log('[Backup] fail', id, e.message); }
      }
    } catch (e) { console.log('[Backup] scheduler err', e.message); }
  });
}

module.exports = { backupServer, startScheduler, listBackups, deleteBackup, restoreBackup, backupPath: validName, BACKUPS_DIR, isDrive: () => !!drive };
