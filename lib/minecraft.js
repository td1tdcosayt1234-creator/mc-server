const { spawn, exec, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const props = require('./props');

// CWD-independent: always resolve against the app root (panel folder), not process.cwd()
const SERVERS_DIR = path.resolve(__dirname, '..', process.env.SERVERS_DIR || './servers');
if (!fs.existsSync(SERVERS_DIR)) fs.mkdirSync(SERVERS_DIR, { recursive: true });

const CORES = os.cpus().length || 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- netstat port scan: koner pid konesha port LISTENING ----
let nsCache = { at: 0, map: {} };
async function netstatListenMap() {
  if (Date.now() - nsCache.at < 10000) return nsCache.map;
  const map = {};
  try {
    const out = await new Promise((res, rej) =>
      exec('netstat -ano -p tcp', { timeout: 8000 }, (e, so) => e ? rej(e) : res(String(so))));
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*T?CP\s+\S+:(\d+)\s+\S*\s+LISTENING\s+(\d+)/i);
      if (m) map[m[1]] = parseInt(m[2]);
    }
    nsCache = { at: Date.now(), map };
  } catch {}
  return map;
}
async function portOwnerPid(port) {
  const m = await netstatListenMap();
  return m[String(port)] || null;
}
function allKnownPids() { return [...running.values()].map(r => r.pid).filter(Boolean); }

// port holder je pid tar taskkill (orphan safe)
async function hardStop(id, knownPid = null) {
  try { if (knownPid) exec(`taskkill /PID ${knownPid} /T /F`); } catch {}
  const port = props.getPort(SERVERS_DIR, id) || 25565;
  for (let i = 0; i < 5; i++) {
    await sleep(1200);
    const pid = await portOwnerPid(port);
    if (pid == null || pid === knownPid) break;
    try { exec(`taskkill /PID ${pid} /T /F`); } catch {}
  }
}

const running = new Map();   // id -> { proc, pid, ram, startedAt, cpuSec, cpuAt, extra }
const logsBuf = new Map();   // id -> [lines]
const sseClients = new Map(); // id -> Set(res)
const stats = new Map();     // id -> { cpu, memMB, uptime, running }
const autoRestart = new Set();
const crashCount = new Map(); // id -> consecutive crash try count (4 hole auto-restart off)

function serverPath(id) { return path.join(SERVERS_DIR, id); }
function javaCmd(bin) { return bin && fs.existsSync(bin) ? bin : 'java'; }

function pushLog(id, line) {
  if (!logsBuf.has(id)) logsBuf.set(id, []);
  const arr = logsBuf.get(id);
  arr.push(line);
  if (arr.length > 1200) arr.splice(0, arr.length - 1200);
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
    return fs.readFileSync(f, 'utf8').split('\n').slice(-tail);
  } catch { return []; }
}

// ---- Version lists: vanilla + paper + purpur + fabric + spigot (30 min cache) ----
let versionCache = { at: 0, data: null };
// fill.papermc.io proper User-Agent chay
const UA = { headers: { 'User-Agent': 'MC-Panel/2.0 (panel app; +local)' }, redirect: 'follow' };
function mkFetch(url) { return fetch(url, UA); }

async function listVersions() {
  if (versionCache.data && Date.now() - versionCache.at < 30 * 60 * 1000) return versionCache.data;
  const out = { vanilla: [], paper: [], purpur: [], fabric: [], spigot: [], folia: [], quilt: [], neoforge: [], craftbukkit: [] };
  try {
    const r = await mkFetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const j = await r.json();
    const rel = j.versions.filter(v => v.type === 'release').map(v => v.id);
    out.vanilla = rel.slice(0, 30);
    out.spigot = rel.slice(0, 30);
    out.fabric = rel.slice(0, 30);
  } catch { out.vanilla = out.spigot = out.fabric = ['1.21.1', '1.21', '1.20.1']; }
  try {
    const r2 = await mkFetch('https://fill.papermc.io/v3/projects/paper/versions');
    const j2 = await r2.json();
    out.paper = (j2.versions || []).map(v => v.version.id).filter(id => !id.includes('-rc') && !id.includes('-pre')).slice(0, 30);
  } catch { out.paper = ['1.21.1', '1.21', '1.20.1']; }
  try {
    const r3 = await mkFetch('https://api.purpurmc.org/v2/purpur');
    const j3 = await r3.json();
    out.purpur = (j3.versions || []).slice(-30).reverse();
  } catch { out.purpur = ['1.21.1', '1.20.1']; }
  try {
    const rf = await mkFetch('https://fill.papermc.io/v3/projects/folia/versions');
    const jf = await rf.json();
    out.folia = (jf.versions || []).map(v => v.version.id).filter(id => !id.includes('-rc') && !id.includes('-pre')).slice(0, 15);
  } catch { out.folia = ['1.21.1', '1.20.1']; }
  if (!out.folia.length) out.folia = ['1.21.1', '1.20.1'];
  try {   // neoforge — maven stable versions "26.3.0.86" (4 numeric segs, no -beta)
    const rn = await mkFetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    const jn = await rn.json();
    out.neoforge = (jn.versions || []).filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v)).slice(-15).reverse();
  } catch { out.neoforge = ['1.21.1-21.1.87', '1.20.4-20.4.237']; }
  if (!out.neoforge.length) out.neoforge = ['1.21.1-21.1.87', '1.20.4-20.4.237'];
  try {   // quilt — game meta list
    const rq = await mkFetch('https://meta.quiltmc.org/v3/versions/game?stable=true&limit=30');
    const jq = await rq.json();
    out.quilt = (Array.isArray(jq) ? jq : jq.versions || []).map(x => x.version).filter(Boolean).slice(0, 30);
  } catch { out.quilt = ['1.21.1', '1.20.1']; }
  if (!out.quilt.length) out.quilt = ['1.21.1', '1.20.1'];
  out.craftbukkit = out.vanilla.slice(0, 30);
  if (!out.paper.length) out.paper = ['1.21.1', '1.20.1'];
  if (!out.purpur.length) out.purpur = ['1.21.1', '1.20.1'];
  versionCache = { at: Date.now(), data: out };
  return out;
}

async function downloadServerJar(id, type, version) {
  const dir = serverPath(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jarPath = path.join(dir, 'server.jar');

  if (type === 'paper' || type === 'folia') {
    await fillDownload(id, type, version, jarPath);
  } else if (type === 'quilt') {
    // quilt loader + installer meta (fabric er moto pattern)
    const loaders = await (await mkFetch(`https://meta.quiltmc.org/v3/versions/loader/${version}`)).json();
    if (!loaders.length) throw new Error('quilt loader nai');
    const loader = loaders[0].loader.version;
    const installers = await (await mkFetch('https://meta.quiltmc.org/v3/versions/installer')).json();
    const installer = installers[0].version;
    const url = `https://meta.quiltmc.org/v3/versions/loader/${version}/${loader}/${installer}/server/jar`;
    await streamDownload(id, url, jarPath);
  } else if (type === 'neoforge') {
    await neoforgeInstall(id, String(version), dir, jarPath);
  } else if (type === 'purpur') {
    await streamDownload(id, `https://api.purpurmc.org/v2/purpur/${version}/latest/download`, jarPath);
  } else if (type === 'craftbukkit') {
    await streamDownload(id, `https://download.getbukkit.org/craftbukkit/craftbukkit-${version}.jar`, jarPath);
  } else if (type === 'spigot') {
    await streamDownload(id, `https://download.getbukkit.org/spigot/spigot-${version}.jar`, jarPath);
  } else if (type === 'fabric') {
    const loaders = await (await mkFetch(`https://meta.fabricmc.net/v2/versions/loader/${version}`)).json();
    if (!loaders.length) throw new Error('fabric loader nai');
    const loader = loaders[0].loader.version;
    const installers = await (await mkFetch('https://meta.fabricmc.net/v2/versions/installer')).json();
    const installer = installers[0].version;
    const url = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`;
    await streamDownload(id, url, jarPath);
  } else {
    const manifest = await (await mkFetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
    const v = manifest.versions.find(x => x.id === version);
    if (!v) throw new Error('version not found');
    const meta = await (await mkFetch(v.url)).json();
    await streamDownload(id, meta.downloads.server.url, jarPath, meta.downloads.server.size);
  }
  if (!fs.existsSync(path.join(dir, 'eula.txt'))) fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  if (!fs.existsSync(path.join(dir, 'server.properties'))) {
    fs.writeFileSync(path.join(dir, 'server.properties'),
      `server-port=25565\nquery.port=25565\nmotd=${id} - MC Panel\nonline-mode=true\nwhite-list=false\nmax-players=20\ndifficulty=normal\ngamemode=survival\npvp=true\nenable-command-block=false\nview-distance=10\nsimulation-distance=10\nlevel-seed=\n`);
  }
  pushLog(id, `[Panel] ${type} ${version} downloaded OK (${Math.round(fs.statSync(jarPath).size / 1048576)}MB jar)`);
  return jarPath;
}

// Streaming download - disk ek-line ek-line likhe jai (50MB jar memory-e thakbe na)
const dlProg = new Map();
// fill.papermc.io v3 — paper AND folia ekhon ekta helper diye
const fillBuildCache = new Map();
async function fillDownload(id, project, version, jarPath) {
  const key = `${project}/${version}`;
  const dir = serverPath(id);
  if (fillBuildCache.has(key)) {
    let cached = fillBuildCache.get(key);          // panel restart er por same jar tai download
    await streamDownload(id, cached.url, jarPath, cached.size);
    return;
  }
  // server.jar niye aber ek sathe eula + server.properties setul kora (PaperMC fill API)
  const v = await (await mkFetch(`https://fill.papermc.io/v3/projects/${project}/versions/${version}`)).json();
  const builds = v.builds;
  if (!builds || !builds.length) throw new Error(`${project} build nai`);
  // fill v3: builds array NEWEST FIRST ([latest, ..., oldest]) — puts [0] = latest build
  const build = builds[0];
  const detail = await (await mkFetch(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/${build}`)).json();
  const dl = detail.downloads && (detail.downloads['server:default'] || detail.downloads['server:mojang']);
  if (!dl || !dl.url) throw new Error(`${project} download url nai`);
  fillBuildCache.set(key, { url: dl.url, size: dl.size });
  await streamDownload(id, dl.url, jarPath, dl.size);
}

// NeoForge — installer run kore libraries + win_args tairi, tarpor start marker
async function neoforgeInstall(id, version, dir, jarPath) {
  const { ensureJava, neededJava } = require('./java');
  const instUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  const instPath = path.join(dir, 'neoforge-installer.jar');
  await streamDownload(id, instUrl, instPath);
  pushLog(id, `[Panel] NeoForge installer cholu (${version} — libraries nami teh ~1-2min)...`);
  const jb = (await ensureJava(neededJava(version), l => pushLog(id, l))).bin;
  const r = spawnSync(jb, ['-jar', 'neoforge-installer.jar', '--installServer'], { cwd: dir, timeout: 480000 });
  if (r.status !== 0) throw new Error('neoforge installer fail: ' + String(r.stderr || r.stdout || '').split('\n').slice(-3).join(' '));
  try { fs.unlinkSync(instPath); } catch {}
  // win_args.txt file-ta dhuk bono (run command er reference)
  const argsFile = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', version, 'win_args.txt');
  if (!fs.existsSync(argsFile)) throw new Error('neoforge install ok kintu win_args.txt nei — neoforge variant support na');
  // server.jar e marker leikha (startServer atai read korbe)
  fs.writeFileSync(jarPath, JSON.stringify({ marker: 'serverjar-wrapper', argsFile: path.relative(dir, argsFile).replace(/\\/g, '/') }));
}

function isJarMarker(dir) {
  try {
    const p = path.join(dir, 'server.jar');
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (st.size > 800) return false;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j.marker === 'serverjar-wrapper';
  } catch { return false; }
}
async function streamDownload(id, url, outPath, expectedSize) {
  const res = await fetch(url, { ...UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`download fail ${res.status}: ${url}`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  if (!total) {
    fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  } else {
    let got = 0;
    const ws = fs.createWriteStream(outPath);
    const src = Readable.fromWeb(res.body); // web stream -> node stream
    await new Promise((resolve, reject) => {
      src.on('data', c => {
        got += c.length; ws.write(c);
        const pct = Math.floor(got / total * 100);
        if (pct >= (dlProg.get(id) || 0) + 20) {
          dlProg.set(id, pct);
          pushLog(id, `[Panel] downloading ${type_name(outPath)}... ${Math.round(got / 1048576)}/${Math.round(total / 1048576)}MB (${pct}%)`);
        }
      });
      src.on('end', () => ws.end(resolve));
      src.on('error', reject);
      ws.on('error', reject);
    });
  }
  const st = fs.statSync(outPath);
  if (st.size < 512 * 1024) throw new Error(`downloaded file choto (${st.size}B) - broken link ba rate limited`);
}
function type_name(p) { return path.basename(p); }

function startServer(id, ramMB = 4096, extra = [], auto = true, javaBin = null) {
  if (running.has(id)) return { ok: false, msg: 'already running' };
  const dir = serverPath(id);
  if (!fs.existsSync(path.join(dir, 'server.jar'))) return { ok: false, msg: 'server.jar nai, age download koro' };
  if (auto) autoRestart.add(id);
  const e = (extra || []).filter(Boolean);
  pushLog(id, `[Panel] starting with ${ramMB}MB...`);
  // normal jar → -jar; neoforge marker jar → java @win_args.txt
  const runArgs = isJarMarker(dir)
    ? ['@' + JSON.parse(fs.readFileSync(path.join(dir, 'server.jar'), 'utf8')).argsFile, 'nogui']
    : ['-jar', 'server.jar', 'nogui'];
  const args = [`-Xmx${ramMB}M`, `-Xms${Math.min(1024, ramMB)}M`, ...e, ...runArgs];
  const proc = spawn(javaCmd(javaBin), args, { cwd: dir, shell: false });

  const rec = { proc, pid: proc.pid || null, ram: ramMB, startedAt: Date.now(), cpuSec: null, cpuAt: 0, extra: e, javaBin: javaCmd(javaBin) };
  running.set(id, rec);

  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)));
  proc.on('error', err => {
    pushLog(id, `[Panel] spawn error: ${err.message} (Java install ache kina check koro)`);
    running.delete(id); stats.delete(id); autoRestart.delete(id);
  });
  proc.on('exit', (code) => {
    const r = running.get(id);
    const uptime = r && r.startedAt ? Date.now() - r.startedAt : 0;
    running.delete(id);
    stats.delete(id);
    pushLog(id, `[Panel] exit code ${code}`);
    if (uptime > 90000) crashCount.delete(id);   // 90s+ cholche = healthy run → counter reset
    if (autoRestart.has(id)) {
      const n = (crashCount.get(id) || 0) + 1;
      if (n >= 4) {                              // crash-loop guard: 4 bar por por crash korle off
        autoRestart.delete(id); crashCount.delete(id);
        pushLog(id, '[Panel] crash-loop guard: 4 bar tight crash korse — auto-restart OFF. Console log dekho (port conflict/invalid jar?).');
        return;
      }
      crashCount.set(id, n);
      pushLog(id, `[Panel] crash detected, 5s por auto restart (try ${n}/4)...`);
      const { ram, extra: _e } = rec;
      setTimeout(async () => {
        if (!autoRestart.has(id) || running.has(id)) return;
        // DirectoryLock crash-loop jata block hoiye - port e jodi onno java thake respawn na
        const port = props.getPort(SERVERS_DIR, id) || 25565;
        const owner = await portOwnerPid(port);
        if (owner != null && !allKnownPids().includes(owner)) {
          autoRestart.delete(id);
          pushLog(id, `[Panel] auto-restart THAMSI - port ${port} already onno process (PID ${owner}) use korche. Age oi server stop koro.`);
          return;
        }
        startServer(id, ram, _e, true, rec.javaBin);
      }, 5000);
    }
  });
  return { ok: true, pid: proc.pid };
}

function stopServer(id, manual = true) {
  const r = running.get(id);
  if (!r) { if (manual) autoRestart.delete(id); return { ok: false, msg: 'running na' }; }
  if (manual) autoRestart.delete(id);
  pushLog(id, '[Panel] stopping (graceful)...');
  try { r.proc.stdin.write('stop\n'); } catch {}
  setTimeout(async () => {
    const cur = running.get(id);
    if (cur === r) {
      running.delete(id); stats.delete(id);
      try { expectTermination(cur); } catch {}
      try { await hardStop(id, cur.pid); } catch {}
      pushLog(id, '[Panel] stopped, port released');
    }
  }, 8000);
  return { ok: true };
}

function killServer(id) {
  const r = running.get(id);
  autoRestart.delete(id);
  pushLog(id, '[Panel] KILL (force stop)');
  try { if (process.platform === 'win32' && r && r.pid) exec(`taskkill /PID ${r.pid} /T /F`); else if (r) r.proc.kill('SIGKILL'); } catch {}
  hardStop(id, r ? r.pid : null).catch(() => {});
  running.delete(id); stats.delete(id);
  return { ok: true, msg: r ? 'killed' : 'tracked nai, port-owner kill try holo' };
}

function restartServer(id, ramMB = 4096, extra = [], javaBin = null) {
  if (!running.has(id)) return startServer(id, ramMB, extra, true, javaBin);
  const rec = running.get(id);
  autoRestart.delete(id);
  pushLog(id, '[Panel] restarting... (stop -> start)');
  stopServer(id, false);
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (Date.now() - t0 > 15000) killServer(id);
    if (!running.has(id)) { clearInterval(poll); startServer(id, ramMB, extra, true, javaBin || (rec && rec.javaBin)); }
  }, 500);
  return { ok: true, msg: 'restart starting' };
}

function expectTermination(r) {
  const pid = r.pid;
  if (pid && process.platform === 'win32') exec(`taskkill /PID ${pid} /T /F`);
  else r.proc.kill('SIGKILL');
}

function serverStatus(id) {
  return { running: running.has(id), pid: running.get(id)?.pid || null };
}

function sendCommand(id, cmd) {
  const r = running.get(id);
  const c = String(cmd || '').trim();
  if (!r) return { ok: false, msg: 'running na' };
  if (!c) return { ok: false, msg: 'cmd khali' };
  pushLog(id, `> ${c}`);
  try { r.proc.stdin.write(c + '\n'); } catch (e) { return { ok: false, msg: e.message }; }
  return { ok: true };
}

// ---- Realtime resource stats (CPU%, RAM, uptime) per running server ----
async function sampleStats() {
  const entries = [...running.entries()];
  if (!entries.length) return;
  const pids = entries.map(([, r]) => r.pid).filter(Boolean);
  if (!pids.length) return;
  let rows = [];
  try {
    const out = await new Promise((res, rej) => {
      exec(`powershell -NoProfile -NonInteractive -Command "Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,CPU,WS | ConvertTo-Json -Compress"`,
        { timeout: 4000 }, (e, so) => e ? rej(e) : res(String(so)));
    });
    const j = JSON.parse(out.trim());
    rows = Array.isArray(j) ? j : [j];
  } catch { return; }
  const now = Date.now();
  for (const [id, r] of entries) {
    if (!r.pid) continue;
    const row = rows.find(x => x && Number(x.Id) === r.pid);
    if (!row || row.CPU == null) continue;
    const cpuSec = Number(row.CPU) || 0;
    const prevCpu = r.cpuSec, prevAt = r.cpuAt;
    r.cpuSec = cpuSec; r.cpuAt = now;
    let cpu = 0;
    if (prevCpu != null && prevAt) {
      cpu = Math.max(0, Math.min(CORES * 100, ((cpuSec - prevCpu) / Math.max(0.25, (now - prevAt) / 1000)) / CORES * 100));
    }
    const memMB = row.WS ? Math.round(Number(row.WS) / (1024 * 1024)) : 0;
    stats.set(id, { cpu: Math.round(cpu * 10) / 10, memMB, uptime: now - r.startedAt, running: true });
  }
}

function getStats(id) {
  const s = stats.get(id);
  if (s) return s;
  const r = running.get(id);
  return { cpu: 0, memMB: 0, uptime: r ? Date.now() - r.startedAt : 0, running: running.has(id) };
}

chkJavaWarn();

function chkJavaWarn() {
  exec('java -version', { timeout: 5000 }, (e) => {
    if (e) console.log('[Java] java PATH e nai - server start hobe na. Java 21 install koro.');
  });
}

module.exports = {
  SERVERS_DIR, serverPath, listVersions, downloadServerJar,
  startServer, stopServer, restartServer, killServer,
  serverStatus, sendCommand, sampleStats, getStats,
  portOwnerPid, allKnownPids,
  isRunning: (id) => running.has(id),
  getLogs, loadDiskLog, pushLog, sseClients
};
