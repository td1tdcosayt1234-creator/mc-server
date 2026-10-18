// 🎮 Players — RCON diye: online list, inventory (SNBT parse), location, op/deop/ban/kick/pardon
// RCON auto-enable: server start/restart er AGE server.properties e enable-rcon + port + password likhe deya hoy
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const props = require('./props');
const mc = require('./minecraft');
const rcon = require('./rcon');

const PNAME_OK = /^[A-Za-z0-9_]{1,16}$/;   // vanilla player name — RCON command injection guard
const HOST = '127.0.0.1';

const ACTIONS = {
  op:     n => `op ${n}`,
  deop:   n => `deop ${n}`,
  ban:    n => `ban ${n} Banned via Panel`,
  kick:   n => `kick ${n} Kicked via Panel`,
  pardon: n => `pardon ${n}`,
};

const srvDir = id => path.join(mc.SERVERS_DIR, id);
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}
function opNames(id) {
  return readJson(path.join(srvDir(id), 'ops.json'), []).map(o => o && o.name).filter(Boolean);
}
function banEntries(id) {
  return readJson(path.join(srvDir(id), 'banned-players.json'), [])
    .filter(o => o && typeof o === 'object' && o.name)
    .map(o => ({ name: o.name, reason: o.reason || '', source: o.source || '', expires: o.expires || 'forever' }));
}

// ---- RCON auto-enable: server start/restart er AGE call hoy (running obosthay call korle restart e kaj korbe) ----
async function ensureRcon(id) {
  const all = await db.getServers();
  const s = all.find(x => x.id === id);
  if (!s) throw new Error('server nai');
  let port = s.rconPort, pass = s.rconPass;
  if (!port || !pass) {
    const used = new Set(all.map(x => x.rconPort).filter(Boolean));
    port = 25700 + (parseInt(crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 6), 16) % 280);
    while (used.has(port)) port = port >= 25980 ? 25700 : port + 1;
    pass = crypto.randomBytes(8).toString('hex');
    await db.saveServer({ ...s, rconPort: port, rconPass: pass });
  }
  const raw = props.readRaw(mc.SERVERS_DIR, id) || ['# server.properties - MC Panel', ''];
  props.write(mc.SERVERS_DIR, id, props.setValues(props.parse(raw), {
    'enable-rcon': 'true',
    'rcon.port': String(port),
    'rcon.password': pass,
    'broadcast-rcon-to-ops': 'true',
  }));
  return { port, pass };
}

async function srv(id) {
  const s = (await db.getServers()).find(x => x.id === id);
  if (!s) throw new Error('server nai');
  return s;
}
function noCfgError() {
  return new Error('rcon setup hoy nai — server ekbar Start/Restart korle auto-enable hobe');
}
async function rconFor(id) {
  const s = await srv(id);
  if (!s.rconPort || !s.rconPass) throw noCfgError();
  return s;
}

// ---- 🎮 online list + ops + bans ----
async function list(id) {
  const s = await srv(id);
  const running = mc.isRunning(id);
  const ops = opNames(id), banned = banEntries(id);
  if (!s.rconPort || !s.rconPass) {
    return { ok: false, reason: 'notconfigured', running, ops, banned, error: noCfgError().message };
  }
  try {
    const [txt] = await rcon.run(HOST, s.rconPort, s.rconPass, ['list'], 5000);
    const t = String(txt == null ? '' : txt);
    const m = /there are (\d+)(?: of a max(?:imum)? of (\d+)|\/(\d+)) players online/i.exec(t);
    let names = [];
    const ci = t.lastIndexOf(':');
    if (m && ci >= 0) names = t.slice(ci + 1).split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9_]{1,16}$/.test(x)); // untrusted output — strict filter
    return {
      ok: true, running,
      count: m ? Number(m[1]) : names.length,
      max: m ? Number(m[2] || m[3] || 20) : 20,
      names, ops, banned,
    };
  } catch (e) {
    return {
      ok: false, running, ops, banned,
      reason: running ? 'rcon' : 'offline',
      error: running
        ? `${e.message} — server Restart dile rcon auto-on hobe`
        : 'Server Offline — age Start koro',
    };
  }
}

async function bans(id) {
  await srv(id);
  return { ok: true, banned: banEntries(id) };
}

// ---- data get output helpers ----
function dataPayload(txt) {
  const t = String(txt == null ? '' : txt);
  const i = t.indexOf('entity data: ');
  if (i < 0) throw new Error((t.trim().slice(0, 140)) || 'kono output asheni — player online ache?');
  return t.slice(i + 13).trim();
}
function itemsFrom(out) {
  try {
    const p = dataPayload(out);
    const i = p.indexOf('[');
    if (i < 0) return [];                       // [] error text ba empty — ArmorItems/HandItems optional
    const v = parseSnbt(p.slice(i));
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && x.id) : [];
  } catch { return []; }
}

// ---- 🎒 inventory ----
async function inventory(id, name) {
  const s = await rconFor(id);
  const outs = await rcon.run(HOST, s.rconPort, s.rconPass, [
    `data get entity ${name} Inventory`,
    `data get entity ${name} ArmorItems`,
    `data get entity ${name} HandItems`,
  ], 9000);

  // Inventory strict — player offline thakle ekhanei error message ashe
  const invTxt = dataPayload(outs[0]);
  const ii = invTxt.indexOf('[');
  if (ii < 0) throw new Error(invTxt.slice(0, 140));
  const invRaw = parseSnbt(invTxt.slice(ii));
  const inv = Array.isArray(invRaw) ? invRaw.filter(x => x && typeof x === 'object' && x.id) : [];

  const A = ['boots', 'leggings', 'chestplate', 'helmet'];   // ArmorItems order: feet → head
  const main = new Array(36).fill(null);
  const armor = { boots: null, leggings: null, chestplate: null, helmet: null };
  const hand = { main: null, off: null };

  for (const it of inv) {
    const slot = it.Slot | 0;
    if (slot >= 0 && slot < 36) main[slot] = mkItem(it, slot);
    else if (slot >= 36 && slot <= 39) armor[A[slot - 36]] = mkItem(it, slot);
    else if (slot === 40) hand.off = mkItem(it, 40);
    else if (slot >= 41) hand.main = mkItem(it, slot);        // creative GUI rare case
  }
  itemsFrom(outs[1]).forEach((it, i) => { if (A[i] && !armor[A[i]]) armor[A[i]] = mkItem(it, 36 + i); });
  const hands = itemsFrom(outs[2]);
  if (hands[0] && !hand.main) hand.main = mkItem(hands[0], 41);
  if (hands[1] && !hand.off) hand.off = mkItem(hands[1], 40);

  const list = [];
  main.forEach(x => x && list.push(x));
  A.forEach(k => armor[k] && list.push(armor[k]));
  if (hand.main) list.push(hand.main);
  if (hand.off) list.push(hand.off);
  return { ok: true, player: name, main, armor, hand, list, total: list.length };
}

function mkItem(it, slot) {
  if (!it || !it.id) return null;
  const tag = (it.tag && typeof it.tag === 'object') ? it.tag : {};
  return {
    id: String(it.id),
    count: Math.max(1, Number(it.Count) || 1),
    slot: slot != null ? slot : (it.Slot | 0),
    name: displayName(it),
    ench: Array.isArray(tag.Enchantments) ? tag.Enchantments.length : 0,
  };
}
function displayName(it) {
  const dn = it && it.tag && it.tag.display && it.tag.display.Name;
  if (typeof dn === 'string' && dn.trim()) {
    try {
      const t = txtOf(JSON.parse(dn)).replace(/§./g, '').trim();
      if (t) return t;
    } catch {}
    const clean = dn.replace(/§./g, '').trim();
    if (clean) return clean;
  }
  return prettyId(it.id);
}
function txtOf(n) {
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(txtOf).join('');
  return (n.text != null ? String(n.text) : '') + (n.extra ? txtOf(n.extra) : '');
}
function prettyId(id) {
  return String(id || '').replace(/^minecraft:/, '').replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---- 📍 location ----
async function location(id, name) {
  const s = await rconFor(id);
  const outs = await rcon.run(HOST, s.rconPort, s.rconPass, [
    `data get entity ${name} Pos`,
    `data get entity ${name} Dimension`,
  ], 6000);
  const posTxt = dataPayload(outs[0]);
  const nums = posTxt.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) throw new Error('position parse holo na: ' + posTxt.slice(0, 120));
  let dim = '';
  try {
    dim = String(dataPayload(outs[1] == null ? '' : outs[1]))
      .replace(/["']/g, '').replace(/^minecraft:/, '');
  } catch {}
  return { ok: true, player: name, x: +nums[0], y: +nums[1], z: +nums[2], dim: dim || 'overworld' };
}

// ---- action: op/deop/ban/kick/pardon ----
async function action(id, name, act) {
  if (!PNAME_OK.test(String(name || ''))) throw new Error('player name vul (A-Z a-z 0-9 _)');
  const mk = ACTIONS[act];
  if (!mk) throw new Error('action vul — op/deop/ban/kick/pardon');
  const s = await rconFor(id);
  const [txt] = await rcon.run(HOST, s.rconPort, s.rconPass, [mk(name)], 5000);
  const msg = String(txt == null ? '' : txt).trim();
  return { ok: true, player: name, action: act, msg: msg || 'command pathano holo' };
}

// ---- SNBT (stringified NBT) parser — `data get` output parse korte ----
// support: compound {k:v}, list [..], double/single quoted string (escape+\\u), number suffix b/s/l/f/d
function parseSnbt(str) {
  const s = String(str);
  let i = 0;
  const err = m => { throw new Error('SNBT parse: ' + m + ' @' + i); };
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++; };

  function value() {
    ws();
    const c = s[i];
    if (c === '{') return compound();
    if (c === '[') return list();
    if (c === '"' || c === "'") return quoted(c);
    return scalar();
  }
  function compound() {
    const o = {};
    i++; ws();
    if (s[i] === '}') { i++; return o; }
    for (;;) {
      ws();
      let k;
      if (s[i] === '"' || s[i] === "'") k = quoted(s[i]);
      else {
        const st = i;
        while (i < s.length && s[i] !== ':' && s[i] !== '}') i++;
        k = s.slice(st, i).trim();
      }
      if (s[i] !== ':') err('key colon');
      i++;
      o[k] = value();
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return o; }
      err('compound close');
    }
  }
  function list() {
    const a = [];
    i++; ws();
    if (s[i] === ']') { i++; return a; }
    for (;;) {
      a.push(value());
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return a; }
      err('list close');
    }
  }
  function quoted(q) {
    let out = '';
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16) || 63); i += 6; continue; }
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i += 2;
        continue;
      }
      if (c === q) { i++; return out; }
      out += c; i++;
    }
    return err('string close');
  }
  function scalar() {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (m && m[0]) {
      i += m[0].length;
      const nxt = s[i];
      if (nxt && /[bslfdBSLFD]/.test(nxt)) i++;
      return Number(m[0]);
    }
    const st = i;
    while (i < s.length && s[i] !== ',' && s[i] !== ']' && s[i] !== '}' && s[i] !== ' ') i++;
    const t = s.slice(st, i);
    if (t === 'true') return true;
    if (t === 'false') return false;
    return t;
  }

  return value();
}

module.exports = { PNAME_OK, ensureRcon, list, bans, inventory, location, action, parseSnbt };
