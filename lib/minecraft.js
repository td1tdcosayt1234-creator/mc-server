const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVERS_DIR = path.resolve(process.env.SERVERS_DIR || './servers');
if (!fs.existsSync(SERVERS_DIR)) fs.mkdirSync(SERVERS_DIR, { recursive: true });

const running = new Map(); // id -> ChildProcess
const logsBuf = new Map(); // id -> [lines]
const sseClients = new Map(); // id -> Set(res)

function serverPath(id) { return path.join(SERVERS_DIR, id); }
function javaCmd() { return 'java'; }

function pushLog(id, line) {
  if (!logsBuf.has(id)) logsBuf.set(id, []);
  const arr = logsBuf.get(id);
  arr.push(line);
  if (arr.length > 800) arr.splice(0, arr.length - 800);
  const set = sseClients.get(id);
  if (set) for (const res of [...set]) { try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { set.delete(res); } }
}
function getLogs(id, tail = 150) {
  const arr = logsBuf.get(id) || [];
  return arr.slice(-tail);
}
function loadDiskLog(id, tail = 150) {
  try {
    const f = path.join(serverPath(id), 'logs', 'latest.log');
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    return lines.slice(-tail);
  } catch { return []; }
}

// ---- Version lists: vanilla + paper + purpur + fabric + spigot ----
async function listVersions() {
  const out = { vanilla: [], paper: [], purpur: [], fabric: [], spigot: [] };
  try {
    const r = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const j = await r.json();
    const rel = j.versions.filter(v => v.type === 'release').map(v => v.id);
    out.vanilla = rel.slice(0, 30);
    out.spigot = rel.slice(0, 30); // spigot follows vanilla versions
    out.fabric = rel.slice(0, 30);
  } catch { out.vanilla = out.spigot = out.fabric = ['1.21.1', '1.21', '1.20.1']; }
  try {
    const r2 = await fetch('https://fill.papermc.io/v3/projects/paper/versions');
    const j2 = await r2.json();
    out.paper = (j2.versions || []).map(v => v.version.id).filter(id => !id.includes('-rc') && !id.includes('-pre')).slice(0, 30);
  } catch { out.paper = ['1.21.1', '1.21', '1.20.1']; }
  try {
    const r3 = await fetch('https://api.purpurmc.org/v2/purpur');
    const j3 = await r3.json();
    out.purpur = (j3.versions || []).slice(-30).reverse();
  } catch { out.purpur = ['1.21.1', '1.20.1']; }
  if (!out.paper.length) out.paper = ['1.21.1', '1.20.1'];
  if (!out.purpur.length) out.purpur = ['1.21.1', '1.20.1'];
  return out;
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download fail ${r.status}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function downloadServerJar(id, type, version) {
  const dir = serverPath(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jarPath = path.join(dir, 'server.jar');

  if (type === 'paper') {
    const v = await (await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${version}`)).json();
    const builds = v.builds;
    if (!builds || !builds.length) throw new Error('paper build nai');
    const build = builds[builds.length - 1];
    const detail = await (await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/${build}`)).json();
    fs.writeFileSync(jarPath, await fetchBuf(detail.downloads['server:default'].url));
  } else if (type === 'purpur') {
    // https://api.purpurmc.org/v2/purpur/<ver>/latest/download
    fs.writeFileSync(jarPath, await fetchBuf(`https://api.purpurmc.org/v2/purpur/${version}/latest/download`));
  } else if (type === 'spigot') {
    // GetBukkit direct jar
    fs.writeFileSync(jarPath, await fetchBuf(`https://download.getbukkit.org/spigot/spigot-${version}.jar`));
  } else if (type === 'fabric') {
    // Fabric meta: loader + installer -> server jar
    const loaders = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${version}`)).json();
    if (!loaders.length) throw new Error('fabric loader nai');
    const loader = loaders[0].loader.version;
    const installers = await (await fetch('https://meta.fabricmc.net/v2/versions/installer')).json();
    const installer = installers[0].version;
    const url = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`;
    fs.writeFileSync(jarPath, await fetchBuf(url));
  } else {
    // vanilla
    const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
    const v = manifest.versions.find(x => x.id === version);
    if (!v) throw new Error('version not found');
    const meta = await (await fetch(v.url)).json();
    fs.writeFileSync(jarPath, await fetchBuf(meta.downloads.server.url));
  }
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  if (!fs.existsSync(path.join(dir, 'server.properties'))) {
    fs.writeFileSync(path.join(dir, 'server.properties'),
      `server-port=25565\nmax-players=20\nmotd=${id} - MC Panel\nonline-mode=true\n`);
  }
  pushLog(id, `[Panel] ${type} ${version} downloaded OK`);
  return jarPath;
}

const autoRestart = new Set();

function startServer(id, ramMB = 4096, auto = true) {
  const dir = serverPath(id);
  if (running.has(id)) return { ok: false, msg: 'already running' };
  if (!fs.existsSync(path.join(dir, 'server.jar'))) return { ok: false, msg: 'server.jar nai, age download koro' };
  if (auto) autoRestart.add(id);
  pushLog(id, `[Panel] starting with ${ramMB}MB...`);
  const proc = spawn(javaCmd(), [`-Xmx${ramMB}M`, `-Xms${Math.min(1024, ramMB)}M`, '-jar', 'server.jar', 'nogui'],
    { cwd: dir, shell: false });
  proc.stdout.on('data', d => {
    const s = d.toString();
    console.log(`[${id}]`, s.slice(0, 200));
    s.split('\n').filter(Boolean).forEach(l => pushLog(id, l));
  });
  proc.stderr.on('data', d => {
    const s = d.toString();
    console.log(`[${id}-err]`, s.slice(0, 200));
    s.split('\n').filter(Boolean).forEach(l => pushLog(id, l));
  });
  proc.on('exit', (code) => {
    running.delete(id);
    pushLog(id, `[Panel] exit code ${code}`);
    if (autoRestart.has(id)) {
      console.log(`[${id}] exit ${code}, 5s por auto restart...`);
      setTimeout(() => { if (autoRestart.has(id) && !running.has(id)) startServer(id, ramMB, true); }, 5000);
    }
  });
  running.set(id, proc);
  return { ok: true, pid: proc.pid };
}
function stopServer(id, manual = true) {
  const proc = running.get(id);
  if (!proc) { if (manual) autoRestart.delete(id); return { ok: false, msg: 'running na' }; }
  if (manual) autoRestart.delete(id);
  pushLog(id, '[Panel] stopping...');
  try { proc.stdin.write('stop\n'); } catch {}
  setTimeout(() => { try { proc.kill(); } catch {} running.delete(id); }, 8000);
  return { ok: true };
}
function serverStatus(id) {
  return { running: running.has(id), pid: running.get(id)?.pid || null };
}
function sendCommand(id, cmd) {
  const proc = running.get(id);
  if (!proc) return { ok: false, msg: 'running na' };
  pushLog(id, `> ${cmd}`);
  proc.stdin.write(cmd + '\n');
  return { ok: true };
}

module.exports = { SERVERS_DIR, serverPath, listVersions, downloadServerJar, startServer, stopServer, serverStatus, sendCommand, isRunning: (id) => running.has(id), getLogs, loadDiskLog, pushLog, sseClients };
