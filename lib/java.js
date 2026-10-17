// Auto Java runtime manager — version onujayi classic JRE (Temurin) nijei download/extract/verify kore
// runtime/java-<major>/ folder e rakhhe. System java version match korle seta use hoi (download lagbe na).
const fs = require('fs');
const path = require('path');
const { exec, spawnSync } = require('child_process');
const { Readable } = require('stream');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const UA = { headers: { 'User-Agent': 'MC-Panel/2.0 (panel app; +local)' }, redirect: 'follow' };
const WIN = process.platform === 'win32';
const EXE = WIN ? 'java.exe' : 'java';

let sysCache = { at: 0, major: null, path: 'java' };

// system java -version parse (8 → "1.8.0_xxx", 21 → "21.0.x")
function systemJava() {
  return new Promise(resolve => {
    if (sysCache.major && Date.now() - sysCache.at < 60 * 1000) return resolve(sysCache);
    exec('java -version', { timeout: 8000 }, (e, so, se) => {
      const out = String(se || so || '');
      const m = out.match(/version "(\d+)(?:\.(\d+))?(\._?\d+)?/);
      let major = null, line = '';
      if (m) {
        major = (+m[1] === 1) ? (+m[2] || 8) : +m[1];
        line = (out.split(/\r?\n/)[0] || '').trim();
      }
      sysCache = { at: Date.now(), major, path: major != null ? 'java' : 'java' };
      resolve(sysCache);
    });
  });
}

// MC version string -> konesha Java major lagbe
function neededJava(version) {
  const v = String(version || '');
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 17;
  if (+m[1] === 1) {
    if (+m[2] > 20) return 21;                                  // 1.21+
    if (+m[2] === 20 && m[3] != null && +m[3] >= 5) return 21;  // 1.20.5/6
    if (+m[2] >= 17) return 17;                                 // 1.17 - 1.20.4
    return 8;                                                   // 1.16.x er necha (Java 8)
  }
  return 8;
}

// runtime/java-<major>/ er vitor bin/java.exe khuje ber kori (zip er nested folder handle kore)
function findJavaExe(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findJavaExe(p, depth + 1); if (r) return r; }
    else if (e.isFile() && e.name === EXE && path.basename(dir).toLowerCase() === 'bin') return p;
  }
  return null;
}

function runtimeDir(major) { return path.join(RUNTIME_DIR, `java-${major}`); }
function runtimeJava(major) { return findJavaExe(runtimeDir(major)); }

// runtime e kon kon major installed (api/info er jonno)
function listRuntimes() {
  const out = [];
  try {
    for (const d of fs.readdirSync(RUNTIME_DIR)) {
      const m = d.match(/^java-(\d+)$/);
      if (m && runtimeJava(+m[1])) out.push(+m[1]);
    }
  } catch {}
  return out.sort((a, b) => a - b);
}

// extracted JRE ta really major kina — jala -version output parse kore Confirm
function verifyJava(exe, major) {
  const r = spawnSync(exe, ['-version'], { timeout: 30000 });
  const out = String(r.stderr || r.stdout || '');
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  const got = m ? ((+m[1] === 1) ? (+m[2] || 8) : +m[1]) : null;
  return { ok: got === major, got, line: (out.split(/\r?\n/)[0] || '').trim() };
}

const inflight = new Map(); // major -> Promise (dhoira download ekbar)
async function ensureJava(major, logFn = () => {}) {
  const want = +major || 17;
  const sys = await systemJava();
  if (sys.major === want) return { bin: sys.path || 'java', major: want, source: 'system' };
  if (!/^\d+$/.test(String(want))) throw new Error(`java major vul: ${major}`);

  const found = runtimeJava(want);
  if (found) return { bin: found, major: want, source: 'runtime' };

  if (inflight.has(want)) return inflight.get(want);
  const job = (async () => {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const zip = path.join(RUNTIME_DIR, `temurin-${want}-${WIN ? 'win-x64' : 'linux-x64'}-jre.zip`);
    const url = `https://api.adoptium.net/v3/binary/latest/${want}/ga/windows/x64/jre/hotspot/normal/eclipse`;
    logFn(`[Panel] Java ${want} runtime niye jel cholche (Temurin JRE, ~45MB) — one time kaj...`);
    const res = await fetch(url, UA);
    if (!res.ok) throw new Error(`adoptium download fail HTTP ${res.status} (Java ${want})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let lastPct = 0;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(zip);
      const src = Readable.fromWeb(res.body);
      let got = 0;
      src.on('data', c => {
        got += c.length; ws.write(c);
        if (total) {
          const pct = Math.floor(got / total * 100);
          if (pct >= lastPct + 25) {
            lastPct = pct;
            logFn(`[Panel] Java ${want} download... ${Math.round(got / 1048576)}MB (${pct}%)`);
          }
        }
      });
      src.on('end', () => ws.end(resolve));
      src.on('error', reject);
      ws.on('error', reject);
    });

    logFn(`[Panel] Java ${want} extract hocha...`);
    fs.rmSync(runtimeDir(want), { recursive: true, force: true });
    fs.mkdirSync(runtimeDir(want), { recursive: true });
    let r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$ProgressPreference='SilentlyContinue'; Expand-Archive -Force -Path ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(runtimeDir(want))}`],
      { timeout: 420000 });
    let exe = findJavaExe(runtimeDir(want));
    if (!exe) {  // fallback: bsdtar (Windows 10+) zip extract kore
      try { spawnSync('tar', ['-xf', zip, '-C', runtimeDir(want)], { timeout: 420000 }); } catch {}
      exe = findJavaExe(runtimeDir(want));
    }
    if (!exe) {
      try { fs.rmSync(runtimeDir(want), { recursive: true, force: true }); } catch {}
      throw new Error(`Java ${want} extract fail (zip ta bad holo) — abar try korle abar download hobe`);
    }
    try { fs.rmSync(zip, { force: true }); } catch {}

    const v = verifyJava(exe, want);
    if (!v.ok) throw new Error(`Java ${want} verify fail — major ${v.got} pawa gese: ${v.line}`);
    logFn(`[Panel] Java ${want} ready ✅ ${v.line} (${exe})`);
    return { bin: exe, major: want, source: 'runtime' };
  })().finally(() => inflight.delete(want));
  inflight.set(want, job);
  return job;
}

module.exports = { RUNTIME_DIR, systemJava, neededJava, ensureJava, runtimeJava, listRuntimes, verifyJava };
