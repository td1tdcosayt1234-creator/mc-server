require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./lib/db');
const mc = require('./lib/minecraft');
const backup = require('./lib/backup');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync('.env') && fs.existsSync('.env.example')) fs.copyFileSync('.env.example', '.env');

// ---- Versions: sob select kora jabe ----
app.get('/api/versions', async (req, res) => {
  res.json(await mc.listVersions());
});

// ---- Servers ----
app.get('/api/servers', async (req, res) => {
  const list = await db.getServers();
  res.json(list.map(s => ({ ...s, ...mc.serverStatus(s.id) })));
});
app.post('/api/servers', async (req, res) => {
  const { name, type, version, ram } = req.body;
  if (!name || !version) return res.status(400).json({ error: 'name + version lagbe' });
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    await mc.downloadServerJar(id, type || 'paper', version);
  } catch (e) { return res.status(500).json({ error: 'download fail: ' + e.message }); }
  const srv = await db.saveServer({ id, name, type: type || 'paper', version, ram: ram || 4096, createdAt: new Date().toISOString() });
  res.json(srv);
});
app.post('/api/servers/:id/start', (req, res) => {
  const r = mc.startServer(req.params.id, req.body.ram || 4096);
  res.json(r);
});
app.post('/api/servers/:id/stop', (req, res) => res.json(mc.stopServer(req.params.id)));
app.post('/api/servers/:id/command', (req, res) => res.json(mc.sendCommand(req.params.id, req.body.cmd || '')));
// ---- Real terminal: logs + live SSE ----
app.get('/api/servers/:id/logs', (req, res) => {
  const tail = parseInt(req.query.tail || '150', 10);
  const mem = mc.getLogs(req.params.id, tail);
  const logs = mem.length ? mem : mc.loadDiskLog(req.params.id, tail);
  res.json({ logs, running: mc.isRunning(req.params.id) });
});
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
app.post('/api/servers/:id/backup', async (req, res) => {
  try { const z = await backup.backupServer(req.params.id, mc.SERVERS_DIR); res.json({ ok: true, file: z }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/servers/:id', async (req, res) => {
  try { mc.stopServer(req.params.id); } catch {}
  await db.deleteServer(req.params.id);
  res.json({ ok: true });
});

// ---- Users (Firebase / local) ----
app.get('/api/users', async (req, res) => res.json(await db.getUsers()));
app.post('/api/users', async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email lagbe' });
  res.json(await db.saveUser({ email, role: role || 'user', createdAt: new Date().toISOString() }));
});

// ---- Panels ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Home: http://localhost:${PORT}/  User: http://localhost:${PORT}/user  Admin: http://localhost:${PORT}/admin`);
  backup.startScheduler(async () => (await db.getServers()).map(s => s.id), mc.SERVERS_DIR);
  // reboot/panel restart hoile sob server auto start
  try {
    const all = await db.getServers();
    for (const s of all) {
      try { mc.startServer(s.id, s.ram || 4096, true); console.log(`[AutoStart] ${s.id}`); } catch (e) { console.log(`[AutoStart] fail ${s.id}:`, e.message); }
    }
  } catch (e) { console.log('[AutoStart] err', e.message); }
});
