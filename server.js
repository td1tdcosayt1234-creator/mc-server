// .env setup BEFORE dotenv loads (CWD-independent: always panel folder)
const fs0 = require('fs');
const path0 = require('path');
const ENV_PATH = path0.join(__dirname, '.env');
if (!fs0.existsSync(ENV_PATH) && fs0.existsSync(path0.join(__dirname, '.env.example'))) {
  fs0.copyFileSync(path0.join(__dirname, '.env.example'), ENV_PATH);
}
require('dotenv').config({ path: ENV_PATH });
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const fs = fs0;
const db = require('./lib/db');
const mc = require('./lib/minecraft');
const backup = require('./lib/backup');
const files = require('./lib/files');
const props = require('./lib/props');
const java = require('./lib/java');
const auth = require('./lib/auth');
const plugins = require('./lib/plugins');
const players = require('./lib/players');

const SERVERS_DIR = mc.SERVERS_DIR;

const app = express();
app.disable('x-powered-by');
app.use(cors());
// 10mb: file editor er save (5MB limit) + raw properties JSON e jate dhore (default 100kb chilo — boro file save fail hoto)
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// body-parser error (payload too large / malformed json) — HTML na, clean JSON pathai
app.use('/api', (err, req, res, next) => {
  if (!err) return next();
  const code = err.status || err.statusCode || 400;
  const msg = err.type === 'entity.too.large' ? `body onek boro (${Math.round((err.limit || 0) / 1048576)}MB limit)` : err.message;
  if (!res.headersSent) res.status(code).json({ error: msg });
});

// ok(): sync + async + res.json() dujoner handler-i handle kore (res.json 'this' return kore — promise na!)
// middleware mounted holeo next thake — er jonno (req,res,next) signature
const ok = fn => (req, res, next) => { try { return Promise.resolve(fn(req, res, next)).catch(e => { if (!res.headersSent) res.status(400).json({ error: e.message }); else console.log('[err]', e.message); }); } catch (e) { if (!res.headersSent) res.status(400).json({ error: e.message }); } };

// ---- AUTH: cookie session middleware (requireLogin toggle on/off — admin page theke) ----
const loginRequired = () => auth.settings().requireLogin !== false; // default ON (admin page theke off kora jai)
const OPEN_API = ['/auth/signup', '/auth/login', '/auth/me', '/auth/logout', '/versions', '/info'];
// public showcase (home/docs/pricing/status): LOGIN CHARA guest READ-ONLY — nam/status/live logs dekhbe,
// kintu start/stop/command/file/upload/backup/user — sob login er PORE (write action)
const PUBLIC_READ = p =>
  p === '/servers' || /^\/servers\/[^/]+\/(logs|stats|console)$/.test(p);
const SID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // server id — path traversal (%2e%2e etc) block

// brute-force guard: login/signup IP-wise (1 min window)
const authHits = new Map();
function authLimited(ip) {
  const now = Date.now();
  const rec = authHits.get(ip) || { at: now, n: 0 };
  if (now - rec.at > 60 * 1000) { rec.at = now; rec.n = 0; }
  rec.n++;
  authHits.set(ip, rec);
  if (authHits.size > 5000) authHits.clear(); // memory guard
  return rec.n > 15;
}
app.use('/api', async (req, res, next) => {
  req.user = auth.userFromReq(req) || null;
  const p = req.path;
  // /servers/:id er id validation sob route er age (guest logs/console o ekhane dhore)
  if (p.startsWith('/servers/')) {
    const sid = p.split('/')[2];
    if (sid && !SID_OK.test(sid)) return res.status(400).json({ error: 'server id vul' });
  }
  if (p.startsWith('/auth/login') || p.startsWith('/auth/signup')) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'x';
    if (authLimited(ip)) return res.status(429).json({ error: 'onek bar try holo — 1 min por abar' });
  }
  if (OPEN_API.some(x => p === x || p.startsWith(x + '/'))) return next();
  if (req.method === 'GET' && PUBLIC_READ(p)) return next();
  if (loginRequired() && !req.user) return res.status(401).json({ error: 'login lagbe — /login' });
  if (p.startsWith('/users')) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    return next();
  }
  // non-admin: owner-only server access (admin sob dekhbe)
  if (req.user && req.user.role !== 'admin' && p.startsWith('/servers')) {
    const sid = p.split('/')[2];
    if (sid) {
      try {
        const s = (await db.getServers()).find(x => x.id === sid);
        if (s && s.owner !== req.user.id) return res.status(403).json({ error: 'ei server tomar na (owner: ' + (s.owner || 'admin') + ')' });
      } catch {}
      return next();
    }
    req.__ownerOnly = true; // list/create emnei route-handle
    return next();
  }
  return next();
});

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
  let list = await db.getServers();
  if (req.__ownerOnly && req.user && req.user.role !== 'admin') {
    list = list.filter(s => s.owner === req.user.id);
  }
  if (!req.user) list = list.map(s => { const pub = { ...s }; delete pub.owner; delete pub.createdByName; return pub; }); // guest: uid/naam lukano
  res.json(list.map(s => {
    const pub = { ...s, ...mc.serverStatus(s.id), stats: mc.getStats(s.id) };
    delete pub.rconPass; delete pub.rconPort;   // RCON credentials client e jabe na
    return pub;
  }));
}));

app.get('/api/servers/:id', ok(async (req, res) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'server nai' });
  const pub = { ...s, ...mc.serverStatus(s.id), stats: mc.getStats(s.id) };
  delete pub.rconPass; delete pub.rconPort;   // RCON credentials client e jabe na
  res.json(pub);
}));

app.post('/api/servers', ok(async (req, res) => {
  const { name, type, version, ram } = req.body;
  if (!name || !version) return res.status(400).json({ error: 'name + version lagbe' });
  const base = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'srv';
  // ID collision guard: same name hole overwrite na hobe — -2, -3 suffix
  let id = base, n = 2;
  const all = await db.getServers();
  while (all.some(x => x.id === id) || fs.existsSync(path.join(SERVERS_DIR, id))) id = `${base}-${n++}`;
  await mc.downloadServerJar(id, type || 'paper', version);
  const srv = await db.saveServer({ id, name, type: type || 'paper', version, ram: ram || 4096, javaArgs: '', owner: req.user ? req.user.id : 'legacy', createdByName: req.user ? (req.user.name || req.user.email) : 'pre-auth', createdAt: new Date().toISOString() });
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
  try { await players.ensureRcon(req.params.id); } catch (e) { mc.pushLog(req.params.id, '[Panel] rcon setup warn: ' + e.message); } // 🎮 Players feature auto-enable
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
  try { await players.ensureRcon(req.params.id); } catch (e) { mc.pushLog(req.params.id, '[Panel] rcon setup warn: ' + e.message); } // 🎮 Players feature auto-enable
  res.json(mc.restartServer(req.params.id, ram, extra, javaBin));
}));
app.post('/api/servers/:id/kill', (req, res) => res.json(mc.killServer(req.params.id)));

// ---- Real terminal: logs + live SSE + command ----
app.get('/api/servers/:id/logs', ok(async (req, res) => {
  const tail = Math.min(1000, Math.max(1, parseInt(req.query.tail || '150', 10) || 150));
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

// ---- 🎮 Players (RCON): online list / inventory / location / op-deop-ban-kick-pardon ----
const badName = res => res.status(400).json({ error: 'player name vul (A-Z a-z 0-9 _, max 16)' });
app.get('/api/servers/:id/players', ok(async (req, res) => { res.json(await players.list(req.params.id)); }));
app.get('/api/servers/:id/players/banned', ok(async (req, res) => { res.json(await players.bans(req.params.id)); }));
app.get('/api/servers/:id/players/:name/inv', ok(async (req, res) => {
  if (!players.PNAME_OK.test(req.params.name)) return badName(res);
  res.json(await players.inventory(req.params.id, req.params.name));
}));
app.get('/api/servers/:id/players/:name/pos', ok(async (req, res) => {
  if (!players.PNAME_OK.test(req.params.name)) return badName(res);
  res.json(await players.location(req.params.id, req.params.name));
}));
app.post('/api/servers/:id/players/:name/action', ok(async (req, res) => {
  if (!players.PNAME_OK.test(req.params.name)) return badName(res);
  res.json(await players.action(req.params.id, req.params.name, String((req.body || {}).action || '')));
}));

// ---- File manager ----
app.get('/api/servers/:id/files', ok((req, res) => { res.json(files.list(SERVERS_DIR, req.params.id, req.query.dir || '')); }));
app.get('/api/servers/:id/file', (req, res) => {
  try { res.json(files.read(SERVERS_DIR, req.params.id, req.query.path)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/servers/:id/file', (req, res) => {
  try { res.json(files.write(SERVERS_DIR, req.params.id, req.body.path, req.body.content)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/servers/:id/mkdir', ok((req, res) => { res.json(files.mkdir(SERVERS_DIR, req.params.id, req.body.path)); }));
app.post('/api/servers/:id/delete', ok((req, res) => { res.json(files.remove(SERVERS_DIR, req.params.id, req.body.path)); }));
app.post('/api/servers/:id/rename', ok((req, res) => { res.json(files.rename(SERVERS_DIR, req.params.id, req.body.path, req.body.to)); }));
app.post('/api/servers/:id/upload', express.raw({ type: () => true, limit: '500mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('upload body khali — file select koro');
    res.json(files.upload(SERVERS_DIR, req.params.id, req.query.path, req.body));
  }
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
  // stop → process exit + port release porjonto wait (Windows e file-lock thakle restore adha-adhura hoto)
  try { mc.stopServer(req.params.id); } catch {}
  const stopped = await mc.waitStopped(req.params.id, 20000);
  if (!stopped) return res.status(400).json({ error: 'server stop hoy nai — age Stop/Kill kore abar try koro' });
  await backup.restoreBackup(req.params.id, req.params.name, SERVERS_DIR);
  res.json({ ok: true });
}));
app.delete('/api/servers/:id/backups/:name', ok((req, res) => { res.json(backup.deleteBackup(req.params.id, req.params.name)); }));
app.get('/api/servers/:id/backups/:name/download', (req, res) => {
  try {
    const p = backup.backupPath(req.params.id, req.params.name);
    res.download(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- 🧩 Plugin/Mod Market (Modrinth) — install plugins/mods server folder e ----
// server record (type+version) — plugin routes er upor e middleware hisebe
app.use('/api/servers/:id/plugins', ok(async (req, res, next) => {
  const s = (await db.getServers()).find(x => x.id === req.params.id);
  req.__srvType = (s && s.type) || 'paper'; req.__srvVersion = (s && s.version) || '1.21.1';
  next();
}));
// search + installed list gated (PUBLIC_READ nei — manage route), install/delete login-er por
app.get('/api/servers/:id/plugins/search', plugins.search);
app.get('/api/servers/:id/plugins', plugins.listInstalled);
app.post('/api/servers/:id/plugins/install', ok(plugins.install));
app.post('/api/servers/:id/plugins/delete', ok(plugins.remove));

// ---- Users (Firebase / local) — hash/salt kabhi client e jai na ----
app.get('/api/users', ok(async (req, res) => {
  const list = await db.getUsers();
  res.json(list.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, hasPassword: !!(u.hash && u.salt) })));
}));
app.post('/api/users', ok(async (req, res) => {
  const { email, role, password } = req.body;
  if (!email) return res.status(400).json({ error: 'email lagbe' });
  if (password) return res.json(await auth.adminCreate({ email, role, password }));
  res.json(await db.saveUser({ email, role: role || 'user', createdAt: new Date().toISOString() }));
}));
app.delete('/api/users/:id', ok(async (req, res) => res.json(await db.deleteUser(req.params.id))));

// ---- Auth: signup/login/logout/me + panel settings (requireLogin toggle) ----
app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } : null, requireLogin: loginRequired() });});
app.post('/api/auth/signup', ok(async (req, res) => {
  const u = await auth.signup(req.body || {});
  const { user, token } = await auth.login(u.email, (req.body || {}).password);
  auth.setUserCookie(res, token);
  res.json({ ok: true, user });
}));
app.post('/api/auth/login', ok(async (req, res) => {
  const { user, token } = await auth.login((req.body || {}).email, (req.body || {}).password);
  auth.setUserCookie(res, token);
  res.json({ ok: true, user });
}));
app.post('/api/auth/logout', (req, res) => {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)mcpanel_session=([a-f0-9]{64})'));
  if (m) auth.revoke(m[1]);
  auth.clearUserCookie(res);
  res.json({ ok: true });
});
app.post('/api/auth/settings', ok(async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json({ settings: auth.saveSettings({ requireLogin: !!req.body.requireLogin }) });
}));
app.get('/api/auth/settings', ok(async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json({ requireLogin: !!auth.settings().requireLogin });
}));

// ---- Full server delete (stop + folder + db) — admin/owner only ----
app.delete('/api/servers/:id', ok(async (req, res) => {
  const id = req.params.id;
  const s = (await db.getServers()).find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'server nai' });
  mc.killServer(id);
  await mc.waitStopped(id, 15000); // pid liveness check — Windows file lock fix (agei map delete hoa wait bypass hoto)
  await db.deleteServer(id);
  // folder purge — Windows e handle release e delay thake, tai retry/backoff (age silent catch e folder pore thakto)
  const dir = path.join(SERVERS_DIR, id);
  let purged = false;
  for (let i = 0; i < 10 && !purged; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }); } catch {}
    purged = !fs.existsSync(dir);
    if (!purged) await new Promise(r => setTimeout(r, 400));
  }
  if (!purged) {
    // last resort: background e ar ekbar try (kono antivirus/handle late release holeo clean hobe)
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {} }, 5000);
  }
  res.json({ ok: true, deleted: true, filesRemoved: purged, warning: purged ? undefined : 'folder lock — background cleanup try hocche' });
}));

// ---- Pages ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/server', (req, res) => res.redirect('/user'));  // "/server" ake — page list e pathao (404 na)
app.get('/server/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'server.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// ---- 404 catch-all (page + api json) — sob route er PORE ----
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'api route nai: ' + req.path });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

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
    const claimed = new Set();   // boot e ekbar claim — same port duita server racing korle sniping hoy
    for (const s of all) {
      try {
        // port e orphan java thakle boot crash-loop hobe na - skip + clear msg
        const bootPort = props.getPort(mc.SERVERS_DIR, s.id) || 25565;
        const owner = await mc.portOwnerPid(bootPort);
        if (owner != null && !mc.allKnownPids().includes(owner)) {
          console.log(`[AutoStart] skip ${s.id}: port ${bootPort} already used by PID ${owner}`);
          continue;
        }
        if (claimed.has(bootPort)) {
          console.log(`[AutoStart] skip ${s.id}: port ${bootPort} ekta autostart server already claim korche — Settings tab e port change korle cholbe`);
          continue;
        }
        claimed.add(bootPort);
        try { await players.ensureRcon(s.id); } catch (e) { console.log(`[AutoStart] rcon warn ${s.id}:`, e.message); } // 🎮 Players feature auto-enable
        const jb = (await java.ensureJava(java.neededJava(s.version), l => console.log(`[AutoStart ${s.id}] ${l}`))).bin;
        mc.startServer(s.id, s.ram || 4096, String(s.javaArgs || '').trim().split(' ').filter(Boolean), true, jb);
        console.log(`[AutoStart] ${s.id}`);
      } catch (e) { console.log(`[AutoStart] fail ${s.id}:`, e.message); }
    }
  } catch (e) { console.log('[AutoStart] err', e.message); }
});
