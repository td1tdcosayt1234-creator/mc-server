// Real login/signup — crypto scrypt hash + token session (kono naya dependency chara)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL_DB = path.join(__dirname, '..', 'db.json');
const COOKIE = 'mcpanel_session';
const NEXT = 'next';
// fakSession — secure cookie system:
//  - HttpOnly (JS/client script ashe na), SameSite=Lax (CSRF hardening), Path=/
//  - Secure flag auto (https/cloudflare tunnel forward e) — http e off
//  - login 'remember:true' → 30 din session, na hole 7 din
//  - per-user session cap 10 + expire tuke auto prune
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;        // 7 din (default)
const SESSION_TTL_REMEMBER = 30 * 24 * 60 * 60 * 1000; // 30 din (remember me)
const SESSION_CAP = 10;                            // per-user max session
const sessions = new Map(); // token -> { uid, exp }

// data-loss guard: corrupt hole puro khali write na kore corrupt file boje rakhe
function salvageCorrupt() {
  try { fs.copyFileSync(LOCAL_DB, LOCAL_DB + '.corrupt-' + Date.now()); } catch { }
}

// --- session persist: panel restart holei sobai logout hoy na (db.json e token thakte) ---
function loadSessions() {
  try {
    const d = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
    for (const [t, v] of Object.entries(d.sessions || {})) {
      if (v && v.exp > Date.now()) sessions.set(t, v);
    }
  } catch { salvageCorrupt(); }
}
function persistSessions() {
  try {
    const raw = fs.readFileSync(LOCAL_DB, 'utf8');
    const d = JSON.parse(raw);
    const now = Date.now();
    const keep = {};
    for (const [t, v] of sessions) if (v.exp > now) keep[t] = v;
    d.sessions = keep;
    fs.writeFileSync(LOCAL_DB, JSON.stringify(d, null, 2));
  } catch { salvageCorrupt(); }
}
loadSessions();


function loadDb() {
  try {
    if (!fs.existsSync(LOCAL_DB)) return { users: [], servers: [], settings: {} };
    const d = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
    return { users: d.users || [], servers: d.servers || [], settings: d.settings || {} };
  } catch { salvageCorrupt(); return { users: [], servers: [], settings: {} }; }
}
// read-modify-write: db.json er other keys (sessions etc.) haray na — full overwrite hoito session persist hariye jeto
function saveDb(data) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); } catch { salvageCorrupt(); }
  raw.users = data.users;
  raw.servers = data.servers;
  raw.settings = data.settings;
  fs.writeFileSync(LOCAL_DB, JSON.stringify(raw, null, 2));
}

function hashPw(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function pwOk(pw) { return typeof pw === 'string' && pw.length >= 6; }
function emailOk(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

async function signup({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) throw new Error('email format vul');
  if (!pwOk(password)) throw new Error('password min 6 character');
  const data = loadDb();
  if (data.users.some(u => String(u.email).toLowerCase() === email)) throw new Error('ei email already registered');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    email,
    name: String(name || '').trim() || email.split('@')[0],
    role: 'user',
    salt,
    hash: hashPw(password, salt),
    createdAt: new Date().toISOString()
  };
  // first user hobe admin (single self-host panel — sensible default)
  if (!data.users.some(u => u.role === 'admin')) user.role = 'admin';
  data.users.push(user);
  saveDb(data);
  return stripUser(user);
}

function login(email, password, remember) {
  email = String(email || '').trim().toLowerCase();
  const data = loadDb();
  const u = data.users.find(x => String(x.email).toLowerCase() === email && x.hash && x.salt);
  if (!u) throw new Error('email/password match hoy nai');
  const calc = Buffer.from(hashPw(password, u.salt), 'hex');
  const stored = Buffer.from(u.hash, 'hex');
  if (calc.length !== stored.length || !crypto.timingSafeEqual(calc, stored)) throw new Error('email/password match hoy nai');
  return { user: stripUser(u), ...newToken(u.id, remember) };
}

// expire-hoa token prune + per-user cap (purano guli prothome jay)
function pruneSessions() {
  const now = Date.now();
  for (const [t, v] of sessions) if (v.exp < now) sessions.delete(t);
  // deleted user er orphaned token o jure dao
  try {
    const ids = new Set(loadDb().users.map(u => u.id));
    for (const [t, v] of sessions) if (!ids.has(v.uid)) sessions.delete(t);
  } catch { }
}
function capUserSessions(uid) {
  const mine = [...sessions.entries()].filter(([, v]) => v.uid === uid).sort((a, b) => a[1].exp - b[1].exp);
  while (mine.length > SESSION_CAP) { const [old] = mine.shift(); sessions.delete(old); }
}
function newToken(uid, remember) {
  const ttl = remember ? SESSION_TTL_REMEMBER : SESSION_TTL;
  const t = crypto.randomBytes(32).toString('hex');
  pruneSessions();
  sessions.set(t, { uid, exp: Date.now() + ttl });
  capUserSessions(uid);
  persistSessions();
  return { token: t, ttl };
}
function revoke(token) { if (token) { sessions.delete(token); persistSessions(); } }

// cookie parse (req.headers.cookie guli)
function userFromReq(req) {
  const raw = String(req.headers.cookie || '');
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { if (s) sessions.delete(m[1]); return null; }
  const data = loadDb();
  const u = data.users.find(x => x.id === s.uid);
  return u ? { ...stripUser(u), _token: m[1] } : null;
}

// secure: https/cloudflare tunnel er khetre Secure flag (http e off — localhost kaj kore)
function isSecure(req) {
  return !!(req && (req.secure || String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https'));
}
function setUserCookie(res, token, ttlSec, req) {
  let c = `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((ttlSec || SESSION_TTL / 1000)))}`;
  if (isSecure(req)) c += '; Secure';
  res.setHeader('Set-Cookie', c);
}
function clearUserCookie(res, req) {
  let c = `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
  if (isSecure(req)) c += '; Secure';
  res.setHeader('Set-Cookie', c);
}

function stripUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt }; }

// admin panel theke direct add (password set kore)
function adminCreate({ email, password, role }) {
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) throw new Error('email format vul');
  if (!pwOk(password)) throw new Error('password min 6 character');
  const data = loadDb();
  const ex = data.users.find(u => String(u.email).toLowerCase() === email);
  const salt = crypto.randomBytes(16).toString('hex');
  const u = ex || { id: 'u_' + crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  u.email = email; u.role = role || 'user'; u.salt = salt; u.hash = hashPw(password, salt);
  u.name = u.name || email.split('@')[0];
  if (!ex) data.users.push(u);
  saveDb(data);
  return stripUser(u);
}

function settings() { return loadDb().settings; }
function saveSettings(patch) {
  const data = loadDb();
  data.settings = { ...data.settings, ...patch };
  saveDb(data);
  return data.settings;
}

module.exports = { signup, adminCreate, login, userFromReq, revoke, setUserCookie, clearUserCookie, settings, saveSettings, COOKIE };
