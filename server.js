require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');
const db = require('./lib/db');
const mc = require('./lib/minecraft');
const backup = require('./lib/backup');
const files = require('./lib/files');
const props = require('./lib/props');
const java = require('./lib/java');

const SERVERS_DIR = mc.SERVERS_DIR;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync('.env') && fs.existsSync('.env.example')) fs.copyFileSync('.env.example', '.env');

const ok = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));

// ---- Versions: sob select kora jabe ----
app.get('/api/versions', ok(async (req, res) => {
  res.json(await mc.listVersions());
}));

// ---- System info (network tab + java version) ----
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
let javaInfo = { at: 0, major: null, line: null };
function javaCheck() {
  return new Promise(resolve => {
    if (javaInfo.line && Date.now() - javaInfo.at < 60 * 1000) return resolve(javaInfo);
    exec('java -version', { timeout: 6000 }, (e, so, se) => {
      const line = e ? null : String(se || so).split('\n')[0].trim();
      const m = line && /version "(\d+)(?:\.(\d+))?/.exec(line);
      const major = m ? (m[1] === '1' ? parseInt(m[2]) : parseInt(m[1])) : null;
      javaInfo = { at: Date.now(), major, line };
      resolve(javaInfo);
    });
  });
}
// MC version -> Java major mapping ekhon lib/java.js e (auto runtime manager o shekha te)
const neededJava = v => java.neededJava(v);
app.get('/api/info', ok(async (req, res) => {
  const j = await javaCheck();
  res.json({ java: j.line, javaMajor: j.major, jres: java.listRuntimes(), ips: localIPs(), platform: process.platform });
}));

// ---- Servers ----
app.get('/api/servers', ok(async (req, res) => {
  const list = await db.getServers();
  res.json(list.map(s => ({ ...s, ...mc.serverStatus(s.id), stats: mc.getStats(s.id) })));
}));

app.get('/api/servers/:id', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'server nai' });
  res.json({ ...s, ...mc.serverStatus(s.id), stats: mc.getStats(s.id) });
}));

app.post('/api/servers', ok(async (req, res) => {
  const { name, type, version, ram } = req.body;
  if (!name || !version) return res.status(400).json({ error: 'name + version lagbe' });
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'srv';
  await mc.downloadServerJar(id, type || 'paper', version);
  const srv = await db.saveServer({ id, name, type: type || 'paper', version, ram: ram || 4096, javaArgs: '', createdAt: new Date().toISOString() });
  res.json({ ...srv, ...mc.serverStatus(id) });
}));

// ---- Power: start / stop / restart / kill ----
app.post('/api/servers/:id/start', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  if (!fs.existsSync(path.join(SERVERS_DIR, req.params.id, 'server.jar'))) {
    return res.status(400).json({ error: 'server.jar nai - reinstall koro' });
  }
  // AUTO JAVA: server version onujayi matching JRE - system e thakle seta, na thakle runtime download
  let javaBin = null;
  try {
    javaBin = (await java.ensureJava(neededJava(s ? s.version : req.body.version), l => mc.pushLog(req.params.id, l))).bin;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Port conflict guard - duita running server eki port e bind korte parbe na
  const myPort = props.getPort(SERVERS_DIR, req.params.id) || 25565;
  const others = (await db.getServers()).filter(x => x.id !== req.params.id && mc.isRunning(x.id));
  for (const o of others) {
    const op = props.getPort(SERVERS_DIR, o.id);
    if (op === myPort) return res.status(400).json({ error: `port ${myPort} already running server "${o.id}" use korche - oi server stop koro ba Settings tab e server-port change koro` });
  }
  // port e jodi onno kono (tracked na) java binds kore thake - age stop korte hobe
  const otherPid = await mc.portOwnerPid(myPort);
  if (otherPid != null && !mc.allKnownPids().includes(otherPid)) {
    return res.status(400).json({ error: `port ${myPort} already PID ${otherPid} er java holds korche (orphan/conflict). Kill kore abar try koro or port change koro` });
  }
  const ram = parseInt(req.body.ram || (s && s.ram) || 4096, 10) || 4096;
  const extra = String((s && s.javaArgs) || req.body.javaArgs || '').trim().split(' ').filter(Boolean);
  res.json(mc.startServer(req.params.id, ram, extra, true, javaBin));
}));
app.post('/api/servers/:id/stop', (req, res) => res.json(mc.stopServer(req.params.id)));
app.post('/api/servers/:id/restart', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  let javaBin = null;
  try {
    javaBin = (await java.ensureJava(neededJava(s ? s.version : ''), l => mc.pushLog(req.params.id, l))).bin;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const ram = parseInt(req.body.ram || (s && s.ram) || 4096, 10) || 4096;
  const extra = String((s && s.javaArgs) || '').trim().split(' ').filter(Boolean);
  res.json(mc.restartServer(req.params.id, ram, extra, javaBin));
}));
app.post('/api/servers/:id/kill', (req, res) => res.json(mc.killServer(req.params.id)));

// ---- Real terminal: logs + live SSE + command ----
app.get('/api/servers/:id/logs', ok(async (req, res) => {
  const tail = parseInt(req.query.tail || '150', 10);
  const mem = mc.getLogs(req.params.id, tail);
  const logs = mem.length ? mem : mc.loadDiskLog(req.params.id, tail);
  res.json({ logs, running: mc.isRunning(req.params.id) });
}));
app.get('/api/servers/:id/console', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const id = req.params.id;
  if (!mc.sseClients.has(id)) mc.sseClients.set(id, new Set());
  mc.sseClients.get(id).add(res);
  res.write(`data: ${JSON.stringify('[Panel] console connected')}\n\n`);
  req.on('close', () => { mc.sseClients.get(id)?.delete(res); });
});

app.get('/api/servers/:id/stats', (req, res) => res.json(mc.getStats(req.params.id)));
app.post('/api/servers/:id/command', (req, res) => res.json(mc.sendCommand(req.params.id, req.body.cmd || '')));

// ---- File manager ----
app.get('/api/servers/:id/files', ok((req, res) => res.json(files.list(SERVERS_DIR, req.params.id, req.query.dir || ''))));
app.get('/api/servers/:id/file', (req, res) => {
  try { res.json(files.read(SERVERS_DIR, req.params.id, req.query.path)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/servers/:id/file', (req, res) => {
  try { res.json(files.write(SERVERS_DIR, req.params.id, req.body.path, req.body.content)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/servers/:id/mkdir', ok((req, res) => res.json(files.mkdir(SERVERS_DIR, req.params.id, req.body.path))));
app.post('/api/servers/:id/delete', ok((req, res) => res.json(files.remove(SERVERS_DIR, req.params.id, req.body.path))));
app.post('/api/servers/:id/rename', ok((req, res) => res.json(files.rename(SERVERS_DIR, req.params.id, req.body.path, req.body.to))));
app.post('/api/servers/:id/upload', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try { res.json(files.upload(SERVERS_DIR, req.params.id, req.query.path, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/servers/:id/download', (req, res) => {
  try {
    const root = path.join(SERVERS_DIR, req.params.id);
    const p = path.resolve(root, req.query.path || '');
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('forbidden path');
    if (!fs.existsSync(p)) throw new Error('file nai');
    res.download(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- server.properties (Settings tab) ----
app.get('/api/servers/:id/properties', ok((req, res) => {
  const raw = props.readRaw(SERVERS_DIR, req.params.id);
  if (!raw) return res.json({ exists: false, map: {}, raw: '' });
  const map = {};
  for (const e of props.parse(raw)) if (e.key != null) map[e.key] = e.value;
  res.json({ exists: true, map, raw: raw.join('\n') });
}));
app.post('/api/servers/:id/properties', ok((req, res) => {
  if (req.body.raw != null) {
    props.write(SERVERS_DIR, req.params.id, String(req.body.raw).replace(/\r?\n/g, '\n').split('\n'));
  } else {
    const raw = props.readRaw(SERVERS_DIR, req.params.id) || ['# server.properties - MC Panel', ''];
    const lines = props.setValues(props.parse(raw), req.body.values || {});
    props.write(SERVERS_DIR, req.params.id, lines);
  }
  res.json({ ok: true });
}));

// ---- Startup settings (RAM + Java flags) ----
app.get('/api/servers/:id/startup', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'server nai' });
  res.json({ ram: s.ram || 4096, javaArgs: s.javaArgs || '', type: s.type, version: s.version });
}));
app.post('/api/servers/:id/startup', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'server nai' });
  const ram = Math.max(512, Math.min(16384, parseInt(req.body.ram || s.ram || 4096, 10) || 4096));
  const javaArgs = String(req.body.javaArgs == null ? s.javaArgs || '' : req.body.javaArgs).slice(0, 500);
  await db.saveServer({ ...s, ram, javaArgs });
  res.json({ ok: true, ram, javaArgs });
}));

// ---- Backups ----
app.get('/api/servers/:id/backups', (req, res) => res.json(backup.listBackups(req.params.id)));
app.post('/api/servers/:id/backup', ok(async (req, res) => {
  const z = await backup.backupServer(req.params.id, SERVERS_DIR);
  res.json({ ok: true, file: z });
}));
app.post('/api/servers/:id/backups/:name/restore', ok(async (req, res) => {
  try { mc.stopServer(req.params.id); } catch {}
  await backup.restoreBackup(req.params.id, req.params.name, SERVERS_DIR);
  res.json({ ok: true });
}));
app.delete('/api/servers/:id/backups/:name', ok((req, res) => res.json(backup.deleteBackup(req.params.id, req.params.name))));
app.get('/api/servers/:id/backups/:name/download', (req, res) => {
  try {
    const p = backup.backupPath(req.params.id, req.params.name);
    res.download(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Users (Firebase / local) ----
app.get('/api/users', ok(async (req, res) => res.json(await db.getUsers())));
app.post('/api/users', ok(async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email lagbe' });
  res.json(await db.saveUser({ email, role: role || 'user', createdAt: new Date().toISOString() }));
}));
app.delete('/api/users/:id', ok(async (req, res) => res.json(await db.deleteUser(req.params.id))));

// ---- Panels ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/server/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'server.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Home: http://localhost:${PORT}/  User: http://localhost:${PORT}/user  Admin: http://localhost:${PORT}/admin`);
  // resource stats sampler (CPU/RAM per running server)
  setInterval(() => { try { mc.sampleStats(); } catch {} }, 2500);
  // auto backup scheduler
  backup.startScheduler(async () => (await db.getServers()).map(s => s.id), mc.SERVERS_DIR);
  // panel reboot hoile sob server auto start
  try {
    const all = await db.getServers();
    for (const s of all) {
      try {
        // port e orphan java thakle boot crash-loop hobe na - skip + clear msg
        const bootPort = props.getPort(mc.SERVERS_DIR, s.id) || 25565;
        const owner = await mc.portOwnerPid(bootPort);
        if (owner != null && !mc.allKnownPids().includes(owner)) {
          console.log(`[AutoStart] skip ${s.id}: port ${bootPort} already used by PID ${owner}`);
          continue;
        }
        const jb = (await java.ensureJava(java.neededJava(s.version), l => console.log(`[AutoStart ${s.id}] ${l}`))).bin;
        mc.startServer(s.id, s.ram || 4096, String(s.javaArgs || '').trim().split(' ').filter(Boolean), true, jb);
        console.log(`[AutoStart] ${s.id}`);
      } catch (e) { console.log(`[AutoStart] fail ${s.id}:`, e.message); }
    }
  } catch (e) { console.log('[AutoStart] err', e.message); }
});
