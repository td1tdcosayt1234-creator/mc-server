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

// pid alive ache kina — Windows/Linux dutotei kill(pid, 0) existence check hisebe kaj kore
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// port holder je pid tar taskkill (orphan safe) — win32 chara onno platform e SIGKILL
async function hardStop(id, knownPid = null) {
  const killPid = pid => {
    try {
      if (process.platform === 'win32') exec(`taskkill /PID ${pid} /T /F`);
      else process.kill(pid, 'SIGKILL');
    } catch {}
  };
  try { if (knownPid) killPid(knownPid); } catch {}
  const port = props.getPort(SERVERS_DIR, id) || 25565;
  for (let i = 0; i < 5; i++) {
    await sleep(1200);
    const pid = await portOwnerPid(port);
    if (pid == null) break;               // port free — process sotti chole gese
    if (pid !== knownPid) killPid(pid);   // notun orphan owner — takeo kill kori
    // pid === knownPid hole wait kori (process dying, port release howar age break na)
  }
}

// stop/kill er por process really chole gese kina — poll kore wait (restore/delete er age dorkar)
// NOTE: killServer/stopServer('running' entry) agei map theke delete kore fele — tai
// shudhu running.has(id) na, pid liveness check o korte hoy (connection reset/file lock bug fix)
async function waitStopped(id, timeoutMs = 15000) {
  const t0 = Date.now();
  while (true) {
    const tracked = running.has(id);
    const alive = isAlive(lastPids.get(id));
    if (!tracked && !alive) {
      if (!tracked) lastPids.delete(id);
      return true;
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

const running = new Map();   // id -> { proc, pid, ram, startedAt, cpuSec, cpuAt, extra }
const lastPids = new Map();  // id -> pid (killServer/stopServer er por bhi waitStopped pid check korte pare)
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
  // verCmp — "1.20.1" style dotted version numeric compare (borotar age)
  function verCmp(a, b) {
    const A = a.split('.'), B = b.split('.');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const d = (+A[i] || 0) - (+B[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  if (versionCache.data && Date.now() - versionCache.at < 30 * 60 * 1000) return versionCache.data;
  const out = { vanilla: [], paper: [], purpur: [], fabric: [], spigot: [], folia: [], quilt: [], neoforge: [], forge: [], velocity: [], waterfall: [], bungeecord: ['latest'], mohist: [], arclight: [], leaf: [], craftbukkit: [] };
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
  try {   // neoforge — maven stable versions: 3-seg legacy "21.1.87" + 4-seg new "26.3.0.90"
    const rn = await mkFetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
    const jn = await rn.json();
    out.neoforge = (jn.versions || []).filter(v => /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(v)).slice(-15).reverse();
  } catch { out.neoforge = ['26.3.0.90', '21.1.87']; }
  if (!out.neoforge.length) out.neoforge = ['26.3.0.90', '21.1.87'];
  try {   // quilt — game version list (stable only, newest first)
    const rq = await mkFetch('https://meta.quiltmc.org/v3/versions/game');
    const jq = await rq.json();
    out.quilt = (Array.isArray(jq) ? jq : jq.versions || [])
      .filter(x => x && (x.stable === true || x.stable === undefined))
      .map(x => x.version || x).filter(Boolean).slice(0, 30);
  } catch { out.quilt = ['1.21.1', '1.20.1']; }
  if (!out.quilt.length) out.quilt = ['1.21.1', '1.20.1'];
  try {   // forge — promotions_slim.json (installer/args-file era: MC 1.17+ shudu list korbo)
    const rp = await mkFetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const jp = await rp.json();
    out.forge = Object.keys(jp.promos || {})
      .filter(k => k.endsWith('-latest'))
      .map(k => k.replace(/-latest$/, ''))
      .filter(v => { const m = v.match(/^1\.(\d+)/); return m && +m[1] >= 17; })
      .sort((a, b) => verCmp(b, a)).slice(0, 25);
  } catch { out.forge = ['1.21.1', '1.20.1']; }
  if (!out.forge.length) out.forge = ['1.21.1', '1.20.1'];
  try {   // velocity — fill v3 (paper er bhai same API)
    const rv = await mkFetch('https://fill.papermc.io/v3/projects/velocity/versions');
    const jv = await rv.json();
    out.velocity = (jv.versions || []).map(v => v.version.id).slice(0, 15);
  } catch { out.velocity = ['4.3.0', '4.2.1-SNAPSHOT']; }
  if (!out.velocity.length) out.velocity = ['4.3.0'];
  try {   // waterfall — bungee fork (fill v3), EOL kintu download still chole
    const rw = await mkFetch('https://fill.papermc.io/v3/projects/waterfall/versions');
    const jw = await rw.json();
    out.waterfall = (jw.versions || []).map(v => v.version.id).slice(0, 12);
  } catch { out.waterfall = ['1.21', '1.20']; }
  if (!out.waterfall.length) out.waterfall = ['1.21'];
  try {   // mohist — forge+bukkit hybrid (mohistmc api)
    const rm = await mkFetch('https://api.mohistmc.com/project/mohist/versions');
    const jm0 = await rm.json();
    out.mohist = (Array.isArray(jm0) ? jm0 : []).map(x => x.name).sort((a, b) => verCmp(b, a)).slice(0, 15);
  } catch { out.mohist = ['1.21.1', '1.20.1']; }
  if (!out.mohist.length) out.mohist = ['1.20.1'];
  try {   // arclight — forge+bukkit hybrid (github release assets theke mc versions parse)
    const ra = await mkFetch('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=30');
    const ja0 = await ra.json();
    const av = new Set();
    for (const r0 of (Array.isArray(ja0) ? ja0 : [])) {
      for (const a of (r0.assets || [])) { const mm = a.name.match(/-forge-(\d+\.\d+(?:\.\d+)?)-/); if (mm) av.add(mm[1]); }
    }
    out.arclight = [...av].sort((a, b) => verCmp(b, a));
  } catch { out.arclight = ['1.21.1', '1.20.1']; }
  if (!out.arclight.length) out.arclight = ['1.20.1'];
  try {   // leaf — paper fork (leafmc.one), github releases ver-<mcver> tags
    const rl0 = await mkFetch('https://api.github.com/repos/Winds-Studio/Leaf/releases?per_page=30');
    const jl0 = await rl0.json();
    out.leaf = (Array.isArray(jl0) ? jl0 : []).map(r0 => String(r0.tag_name || '').replace(/^ver-/, '')).filter(Boolean).slice(0, 18);
  } catch { out.leaf = ['1.21.11', '26.2']; }
  if (!out.leaf.length) out.leaf = ['1.21.11'];
  out.craftbukkit = out.vanilla.slice(0, 30);
  if (!out.paper.length) out.paper = ['1.21.1', '1.20.1'];
  if (!out.purpur.length) out.purpur = ['1.21.1', '1.20.1'];
  versionCache = { at: Date.now(), data: out };
  return out;
}

// fabric/quilt er server jar ACTUALLY choto (~180KB) bootstrap launcher — dustu moddhe
// launcher, FIRST START e se nije vanilla jar + libraries namiye ney. 512KB min check
// eta bole diye legit jar delete kore felta → 'broken link ba rate limited' bug.
// fuleo broken-link banate kichu choto jar ashlei dhorbo — 64KB bujhiye rani.
const LOOPCHAT_MIN = 64 * 1024;
const BOOTSTRAP_TYPES = new Set(['fabric', 'quilt']);
// valid platform list — notun platform add korle ekhane + nicher branch eo add korte hobe
const KNOWN_TYPES = new Set(['paper', 'folia', 'quilt', 'neoforge', 'forge', 'purpur', 'craftbukkit', 'spigot', 'fabric', 'vanilla',
  'velocity', 'waterfall', 'bungeecord', 'mohist', 'arclight', 'leaf']);
// proxy server der nogui/stop command alada (MC server er moto NA — e.gulo world/rcon chara proxy)
const PROXY_TYPES = new Set(['velocity', 'waterfall', 'bungeecord']);
// server dir e .panel-type likhe rakhe — startServer/stopServer type-aware hobe (nogui, stop command)
function panelType(dir) {
  try { return fs.readFileSync(path.join(dir, '.panel-type'), 'utf8').trim().toLowerCase(); } catch { return ''; }
}

async function downloadServerJar(id, type, version) {
  const dir = serverPath(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jarPath = path.join(dir, 'server.jar');
  // platform onujayi min jar size: fabric/quilt bootstrap choto, baki sohoj full jar
  const minSize = BOOTSTRAP_TYPES.has(String(type)) ? LOOPCHAT_MIN : 512 * 1024;

  if (type === 'paper' || type === 'folia' || type === 'velocity' || type === 'waterfall') {
    // fill v3 ekhon velocity + waterfall o host kore — same paper pattern
    await fillDownload(id, type, version, jarPath);
  } else if (type === 'bungeecord') {
    // BungeeCord — md-5 Jenkins er last successful build (version dropdown e 'latest')
    await streamDownload(id, 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar', jarPath);
  } else if (type === 'mohist') {
    // Mohist — Forge+Bukkit hybrid; api er official latest/download endpoint
    await streamDownload(id, `https://api.mohistmc.com/project/mohist/${version}/builds/latest/download`, jarPath);
  } else if (type === 'arclight') {
    // Arclight — Forge+Bukkit hybrid; github releases er newest forge asset (jar chototé ashte pare → 64KB min)
    const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const relevant = a => new RegExp(`-forge-${esc}-.*\\.jar$`).test(a.name);
    const rel = await (await mkFetch('https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=30')).json();
    const rels = Array.isArray(rel) ? rel : [];
    const pickRel = rels.find(r => (r.assets || []).some(relevant));
    if (!pickRel) throw new Error(`no arclight build for ${version} — check the versions list`);
    const asset = pickRel.assets.find(relevant);
    await streamDownload(id, asset.browser_download_url, jarPath, null, LOOPCHAT_MIN);
  } else if (type === 'leaf') {
    // Leaf — paper fork (Winds-Studio/Leaf); github releases tag ver-<mcver> → jar asset
    const rel = await (await mkFetch('https://api.github.com/repos/Winds-Studio/Leaf/releases?per_page=30')).json();
    const rels = Array.isArray(rel) ? rel : [];
    const tgt = String(version);
    const norm = t => String(t || '').replace(/^ver-/, '');
    const pickRel = rels.find(r => norm(r.tag_name) === tgt) || rels.find(r => norm(r.tag_name).startsWith(tgt));
    if (!pickRel || !(pickRel.assets || []).length) throw new Error(`no leaf release asset for ${version} — check the versions list`);
    await streamDownload(id, pickRel.assets[0].browser_download_url, jarPath);
  } else if (type === 'quilt') {
    // quilt loader + installer meta (fabric er moto pattern)
    const loaders = await (await mkFetch(`https://meta.quiltmc.org/v3/versions/loader/${version}`)).json();
    if (!loaders.length) throw new Error('no quilt loaders found');
    const loader = loaders[0].loader.version;
    const installers = await (await mkFetch('https://meta.quiltmc.org/v3/versions/installer')).json();
    const installer = installers[0].version;
    const url = `https://meta.quiltmc.org/v3/versions/loader/${version}/${loader}/${installer}/server/jar`;
    await streamDownload(id, url, jarPath, null, minSize);
  } else if (type === 'neoforge') {
    await neoforgeInstall(id, String(version), dir, jarPath);
  } else if (type === 'forge') {
    const build = await forgeBuildFor(String(version));
    const full = `${version}-${build}`;
    await installerJarInstall(id, dir, jarPath, {
      instUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
      instFile: 'forge-installer.jar',
      label: `Forge ${full}`,
      mcVer: String(version),
      argsBase: path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge', full)
    });
  } else if (type === 'purpur') {
    await streamDownload(id, `https://api.purpurmc.org/v2/purpur/${version}/latest/download`, jarPath);
  } else if (type === 'craftbukkit') {
    await streamDownload(id, `https://download.getbukkit.org/craftbukkit/craftbukkit-${version}.jar`, jarPath);
  } else if (type === 'spigot') {
    await streamDownload(id, `https://download.getbukkit.org/spigot/spigot-${version}.jar`, jarPath);
  } else if (type === 'fabric') {
    const loaders = await (await mkFetch(`https://meta.fabricmc.net/v2/versions/loader/${version}`)).json();
    if (!loaders.length) throw new Error('no fabric installers found');
    const loader = loaders[0].loader.version;
    const installers = await (await mkFetch('https://meta.fabricmc.net/v2/versions/installer')).json();
    const installer = installers[0].version;
    const url = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`;
    await streamDownload(id, url, jarPath, null, minSize);
  } else if (KNOWN_TYPES.has(type)) {   // vanilla — mojang manifest
    const manifest = await (await mkFetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
    const v = manifest.versions.find(x => x.id === version);
    if (!v) throw new Error('version not found');
    const meta = await (await mkFetch(v.url)).json();
    await streamDownload(id, meta.downloads.server.url, jarPath, meta.downloads.server.size);
  } else {
    // jana-na type silent mely vanilla namato — ekhon clear error
    throw new Error(`unknown platform "${type}" — valid: ${[...KNOWN_TYPES].join(', ')}`);
  }
  if (!fs.existsSync(path.join(dir, 'eula.txt')) && !PROXY_TYPES.has(String(type))) fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  if (!fs.existsSync(path.join(dir, 'server.properties')) && !PROXY_TYPES.has(String(type))) {
    fs.writeFileSync(path.join(dir, 'server.properties'),
      `server-port=25565\nquery.port=25565\nmotd=${id} - MC Panel\nonline-mode=true\nwhite-list=false\nmax-players=20\ndifficulty=normal\ngamemode=survival\npvp=true\nenable-command-block=false\nview-distance=10\nsimulation-distance=10\nlevel-seed=\n`);
  }
  const jarKB = () => Math.round(fs.statSync(jarPath).size / 1024);
  if (isJarMarker(dir)) {   // installer-based (forge/neoforge) — server.jar choto marker, libs pase tairi
    pushLog(id, `[Panel] ${type} ${version} ready — libraries installed + args file set`);
  } else {
    pushLog(id, `[Panel] ${type} ${version} downloaded OK (${Math.round(fs.statSync(jarPath).size / 1048576)}MB jar)`);
  }
  if (BOOTSTRAP_TYPES.has(String(type))) {
    pushLog(id, `[Panel] ${type} launcher bootstrap jar (${jarKB()}KB) — on FIRST START the server downloads the vanilla jar + libraries itself (can take 1-2 min)`);
  }
  if (type === 'velocity') pushLog(id, `[Panel] velocity config lives in velocity.toml — edit it from the Files tab (default port 25565)`);
  // type record — startServer/stopServer proxy-aware hobe (nogui skip + 'end'/'shutdown' stop command)
  try { fs.writeFileSync(path.join(dir, '.panel-type'), String(type)); } catch {}
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
  if (!builds || !builds.length) throw new Error(`no ${project} build found`);
  // fill v3: builds array NEWEST FIRST ([latest, ..., oldest]) — puts [0] = latest build
  const build = builds[0];
  const detail = await (await mkFetch(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/${build}`)).json();
  const dl = detail.downloads && (detail.downloads['server:default'] || detail.downloads['server:mojang']);
  if (!dl || !dl.url) throw new Error(`no ${project} download url`);
  fillBuildCache.set(key, { url: dl.url, size: dl.size });
  await streamDownload(id, dl.url, jarPath, dl.size);
}

// installer-jar based setup (NeoForge / Forge) — installer `--installServer` chalai,
// libraries + win_args/unix_args tairi kore, tarpor server.jar e marker leikha
// (marker startServer atai read kore `@args-file` diye boot korbe)
async function installerJarInstall(id, dir, jarPath, { instUrl, instFile, label, mcVer, argsBase }) {
  const { ensureJava, neededJava } = require('./java');
  const instPath = path.join(dir, instFile);
  await streamDownload(id, instUrl, instPath);
  pushLog(id, `[Panel] running ${label} installer (downloads libraries, ~1-2 min)...`);
  // Note: NeoForge er maven version ("21.1.87") neojJav major diye guess hoi,
  // Forge e real MC version ("1.21.1") dey — duitar mapping neededJava e ache
  const jb = (await ensureJava(neededJava(mcVer), l => pushLog(id, l))).bin;
  // maxBuffer 8MB navate — forge installer hajar "Patching..." line print kore,
  // default 1MB full hole node nijei child kill kore dito (ENOBUFS → "installer fail" empty)
  const r = spawnSync(jb, ['-jar', instFile, '--installServer'], { cwd: dir, timeout: 480000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`${label} installer failed (status=${r.status}${r.error ? ' ' + r.error.code : ''}): ` +
      String(r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300));
  }
  try { fs.unlinkSync(instPath); } catch {}
  // args file khuje nao (win → win_args.txt, linux/mac → unix_args.txt)
  const argsFile = ['win_args.txt', 'unix_args.txt'].map(f => path.join(argsBase, f)).find(f => fs.existsSync(f));
  if (!argsFile) throw new Error(`${label} installed but no args file — variant unsupported`);
  // server.jar e marker leikha (startServer atai read korbe)
  fs.writeFileSync(jarPath, JSON.stringify({ marker: 'serverjar-wrapper', argsFile: path.relative(dir, argsFile).replace(/\\/g, '/') }));
}

async function neoforgeInstall(id, version, dir, jarPath) {
  await installerJarInstall(id, dir, jarPath, {
    instUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`,
    instFile: 'neoforge-installer.jar',
    label: 'NeoForge',
    mcVer: version,
    argsBase: path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', version)
  });
}

// forge build (MC version onujayi) — promos theke latest, na hole recommended
const forgeBuildCache = new Map();
async function forgeBuildFor(mcVer) {
  if (forgeBuildCache.has(mcVer)) return forgeBuildCache.get(mcVer);
  const jp = await (await mkFetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).json();
  const promos = jp.promos || {};
  const b = promos[`${mcVer}-latest`] || promos[`${mcVer}-recommended`];
  if (!b) throw new Error(`no forge build for MC ${mcVer} (panel supports 1.17+)`);
  forgeBuildCache.set(mcVer, b);
  return b;
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
async function streamDownload(id, url, outPath, expectedSize, minSize = 512 * 1024) {
  const cleanup = () => { try { fs.rmSync(outPath, { force: true }); } catch {} };
  try {
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
          got += c.length;
          if (!ws.write(c)) { src.pause(); ws.once('drain', () => src.resume()); } // backpressure — memory blow hoy na
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
    if (st.size < minSize) throw new Error(`downloaded file too small (${st.size}B) - broken link or rate limited (min ${minSize}B)`);
  } catch (e) {
    cleanup(); // broken/partial jar rekhe dile pore "Invalid or corrupt jarfile" crash-loop hoto
    throw e;
  }
}
function type_name(p) { return path.basename(p); }

function startServer(id, ramMB = 4096, extra = [], auto = true, javaBin = null, cpu = 0, major = 0) {
  if (running.has(id)) return { ok: false, msg: 'already running' };
  const dir = serverPath(id);
  if (!fs.existsSync(path.join(dir, 'server.jar'))) return { ok: false, msg: 'server.jar missing — it will be re-downloaded automatically' };
  if (auto) autoRestart.add(id);
  const e = (extra || []).filter(Boolean);
  // CPU select: -XX:ActiveProcessorCount=N → JVM thread pools N processor dhorbe (limitations without OS-level hard kill)
  const args = [`-Xmx${ramMB}M`, `-Xms${Math.min(1024, ramMB)}M`];
  if (cpu >= 1) {
    if (!major || major >= 10) {   // JDK 10+ option — Java 8 e unknown flag dile JVM start-i hobe na
      args.push(`-XX:ActiveProcessorCount=${cpu}`);
      pushLog(id, `[Panel] CPU limit: ${cpu} core(s)`);
    } else pushLog(id, `[Panel] CPU limit skipped — ActiveProcessorCount needs Java 10+ (this server uses Java ${major})`);
  }
  pushLog(id, `[Panel] starting with ${ramMB}MB...`);
  // normal jar → -jar + nogui; neoforge marker jar → java @win_args.txt;
  // proxy (velocity/waterfall/bungee) — 'nogui' flag tomar otay nai, o-specific parse kore
  const dtype = panelType(dir);
  const isProxy = PROXY_TYPES.has(dtype);
  const runArgs = isJarMarker(dir)
    ? ['@' + JSON.parse(fs.readFileSync(path.join(dir, 'server.jar'), 'utf8')).argsFile, 'nogui']
    : isProxy ? ['-jar', 'server.jar'] : ['-jar', 'server.jar', 'nogui'];
  args.push(...e, ...runArgs);
  const proc = spawn(javaCmd(javaBin), args, { cwd: dir, shell: false });

  const rec = { proc, pid: proc.pid || null, ram: ramMB, startedAt: Date.now(), cpuSec: null, cpuAt: 0, extra: e, javaBin: javaCmd(javaBin) };
  running.set(id, rec);

  proc.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)));
  proc.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => pushLog(id, l)));
  proc.on('error', err => {
    pushLog(id, `[Panel] spawn error: ${err.message} (check that Java is installed)`);
    running.delete(id); stats.delete(id); autoRestart.delete(id); lastPids.delete(id);
  });
  proc.on('exit', (code) => {
    const r = running.get(id);
    const uptime = r && r.startedAt ? Date.now() - r.startedAt : 0;
    running.delete(id);
    stats.delete(id);
    lastPids.delete(id); // process sotti gone — pid liveness wait ar lagbe na
    pushLog(id, `[Panel] exit code ${code}`);
    if (uptime > 90000) crashCount.delete(id);   // 90s+ cholche = healthy run → counter reset
    if (autoRestart.has(id)) {
      const n = (crashCount.get(id) || 0) + 1;
      if (n >= 4) {                              // crash-loop guard: 4 bar por por crash korle off
        autoRestart.delete(id); crashCount.delete(id);
        pushLog(id, '[Panel] crash-loop guard: 4 rapid crashes in a row — auto-restart OFF. Check the console log (port conflict / invalid jar?).');
        return;
      }
      crashCount.set(id, n);
      pushLog(id, `[Panel] crash detected, auto restart in 5s (try ${n}/4)...`);
      const { ram, extra: _e } = rec;
      setTimeout(async () => {
        if (!autoRestart.has(id) || running.has(id)) return;
        // DirectoryLock crash-loop jata block hoiye - port e jodi onno java thake respawn na
        const port = props.getPort(SERVERS_DIR, id) || 25565;
        const owner = await portOwnerPid(port);
        if (owner != null && !allKnownPids().includes(owner)) {
          autoRestart.delete(id);
          pushLog(id, `[Panel] auto-restart PAUSED - port ${port} is used by another process (PID ${owner}). Stop that server first.`);
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
  if (!r) { if (manual) autoRestart.delete(id); return { ok: false, msg: 'not running' }; }
  if (manual) autoRestart.delete(id);
  pushLog(id, '[Panel] stopping (graceful)...');
  // MC server → 'stop'; bungee-family → 'end'; velocity → 'shutdown' (proxy der stop command alada)
  const isProxy = PROXY_TYPES.has(panelType(serverPath(id)));
  const stopCmd = panelType(serverPath(id)) === 'velocity' ? 'shutdown' : (isProxy ? 'end' : 'stop');
  try { r.proc.stdin.write(stopCmd + '\n'); } catch {}
  // graceful window 25s — age 8s por force kill chilo: world save 8s+ lagle mid-save
  // process mare jaitto ("Saving chunks" er por force) → exit code 1 + data corruption risk
  const t0 = Date.now();
  const GRACE_MS = 25000;
  const poll = setInterval(() => {
    const cur = running.get(id);
    if (cur !== r) { clearInterval(poll); if (manual) pushLog(id, '[Panel] stopped cleanly — port released'); return; }   // nijei exit — sotti graceful, done
    if (Date.now() - t0 > GRACE_MS) {
      clearInterval(poll);
      pushLog(id, '[Panel] graceful stop unavailable — force kill (save took too long)');
      try { if (cur.pid) lastPids.set(id, cur.pid); } catch {}
      try { expectTermination(cur); } catch {}
      try { running.delete(id); stats.delete(id); } catch {}
      hardStop(id, cur.pid).catch(() => {});
      pushLog(id, '[Panel] stopped (force kill), releasing port...');
    } else if (Date.now() - t0 > 9000 && !r._warnedSave) {
      r._warnedSave = true;
      pushLog(id, '[Panel] server is saving... this part can take a while (big worlds)');
    }
  }, 1000);
  return { ok: true };
}

function killServer(id) {
  const r = running.get(id);
  autoRestart.delete(id);
  if (r && r.pid) lastPids.set(id, r.pid); // running map sync delete hoi — waitStopped pid theke bujhbe
  pushLog(id, '[Panel] KILL (force stop)');
  try { if (process.platform === 'win32' && r && r.pid) exec(`taskkill /PID ${r.pid} /T /F`); else if (r) r.proc.kill('SIGKILL'); } catch {}
  hardStop(id, r ? r.pid : null).catch(() => {});
  running.delete(id); stats.delete(id);
  return { ok: true, msg: r ? 'killed' : 'no tracked process, tried port-owner kill' };
}

function restartServer(id, ramMB = 4096, extra = [], javaBin = null, cpu = 0, major = 0) {
  if (!running.has(id)) return startServer(id, ramMB, extra, true, javaBin, cpu, major);
  const rec = running.get(id);
  autoRestart.delete(id);
  pushLog(id, '[Panel] restarting... (stop -> start)');
  stopServer(id, false);
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (Date.now() - t0 > 15000) killServer(id);
    if (!running.has(id)) { clearInterval(poll); startServer(id, ramMB, extra, true, javaBin || (rec && rec.javaBin), cpu, major); }
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
  if (!r) return { ok: false, msg: 'not running' };
  if (!c) return { ok: false, msg: 'empty command' };
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
    if (e) console.log('[Java] java not on PATH - server won\'t start. Install Java 21.');
  });
}

module.exports = {
  SERVERS_DIR, serverPath, listVersions, downloadServerJar,
  startServer, stopServer, restartServer, killServer, waitStopped,
  serverStatus, sendCommand, sampleStats, getStats,
  portOwnerPid, allKnownPids,
  isRunning: (id) => running.has(id),
  getLogs, loadDiskLog, pushLog, sseClients
};
