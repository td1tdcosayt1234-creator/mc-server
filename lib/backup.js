const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cron = require('node-cron');

const BACKUPS_DIR = path.resolve(process.env.BACKUPS_DIR || './backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

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

async function backupServer(id, serversDir) {
  const src = path.join(path.resolve(serversDir), id);
  if (!fs.existsSync(src)) throw new Error('server folder nai');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipName = `${id}-${stamp}.zip`;
  const zipPath = path.join(BACKUPS_DIR, zipName);
  await zipFolder(src, zipPath);

  if (drive) {
    const fileMeta = { name: zipName, parents: [process.env.DRIVE_FOLDER_ID] };
    await drive.files.create({ requestBody: fileMeta, media: { mimeType: 'application/zip', body: fs.createReadStream(zipPath) } });
    console.log(`[Backup] ${id} -> Drive uploaded`);
  } else {
    console.log(`[Backup] ${id} -> local ${zipName}`);
  }
  // purano local backup clean - 10 ta rakho
  const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.startsWith(id)).sort();
  while (files.length > 10) { const f = files.shift(); try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch {} }
  return zipName;
}

function startScheduler(getServerIds, serversDir) {
  const mins = parseInt(process.env.BACKUP_MINUTES || '50', 10);
  // proti X minute por
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

module.exports = { backupServer, startScheduler, BACKUPS_DIR, isDrive: () => !!drive };
