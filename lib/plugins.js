// 🧩 Plugin/Mod Market — Modrinth v2 API (plugins: paper/spigot/purpur/folia/bukkit, mods: fabric/quilt/neoforge)
// jar download streaming, server er plugins/ ar mods/ folder e boshay (public API, kono key lagbe na)
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const mc = require('./minecraft');

const UA = { headers: { 'User-Agent': 'MC-Panel/2.0 (panel app; github.com/td1tdcosayt1234-creator/mc-server)' }, redirect: 'follow' };
const RQ = (req, res, e) => { if (!res.headersSent) res.status(400).json({ error: e.message }); else console.log('[plugins]', e.message); };

// kind -> (loader list, target folder, project_type)
const KINDS = {
  plugin: {
    dirs: { plugin: 'plugins' },
    type: 'plugin',
    // bukkit family — paper/spigot/bukkit plugin gulo porashporhe chole (paper spigot+bukkit plugin chalay)
    loadersBySrvType: {
      paper: ['paper', 'spigot', 'bukkit'],
      folia: ['folia'],
      purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
      spigot: ['spigot', 'bukkit'],
      craftbukkit: ['bukkit', 'spigot']
    },
    fallbackLoaders: ['paper', 'spigot', 'bukkit', 'purpur', 'folia']
  },
  mod: {
    dirs: { mod: 'mods' },
    type: 'mod',
    // forge classic mods — Modrinth e 'forge' category lagbe (neoforge alada category)
    loadersBySrvType: { fabric: ['fabric'], quilt: ['quilt', 'fabric'], neoforge: ['neoforge'], forge: ['forge'] },
    fallbackLoaders: ['fabric', 'quilt', 'neoforge', 'forge']
  }
};

function kindOf(srvType, kind) {
  const k = KINDS[kind] || KINDS.plugin;
  const loaders = (k.loadersBySrvType[String(srvType || '').toLowerCase()] || k.fallbackLoaders).slice();
  return { ...k, loaders };
}

// rel path user-supplied — server root er vitor thakte hobe (files.js er moto guard)
function resolveIn(serversDir, id, rel) {
  const root = path.join(path.resolve(serversDir), id);
  const p = path.resolve(root, rel || '');
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('forbidden path');
  return { root, p };
}

// ---- SEARCH: GET /api/servers/:id/plugins/search?q=&kind=plugin|mod&all=1 ----
// strict mode (default): server er version + loader ei plugin-i show hobe (versions facet)
// ?all=1 → version filter off (freshness dekhate chaile)
async function search(req, res) {
  try {
    const { kind = 'plugin' } = req.query;
    const q = String(req.query.q || '').slice(0, 80);
    const all = String(req.query.all || '') === '1';
    const srvVer = await req2ver(req);
    const k = kindOf(await req2srv(req), kind);
    const facets = [['project_type:' + k.type], k.loaders.map(l => 'categories:' + l)];
    if (!all) facets.push(['versions:' + srvVer]); // 🔒 server version e build ache — na hole idibe na
    const url = 'https://api.modrinth.com/v2/search?limit=24&index=' + (!q ? 'downloads' : 'relevance') + '&query=' + encodeURIComponent(q) +
      '&facets=' + encodeURIComponent(JSON.stringify(facets));
    const r = await fetch(url, UA);
    if (!r.ok) throw new Error('modrinth search fail ' + r.status);
    const j = await r.json();
    res.json({
      kind, loaders: k.loaders, version: srvVer, strict: !all,
      hits: (j.hits || []).map(h => ({
        slug: h.slug, title: h.title, author: h.author, desc: h.description,
        downloads: h.downloads, icon: h.icon_url, loaders: h.display_categories && h.display_categories.slice(0, 4),
        updated: h.date_modified
      }))
    });
  } catch (e) { RQ(req, res, e); }
}

// ---- INSTALLED LIST: GET /api/servers/:id/plugins ----
function listInstalled(req, res) {
  try {
    const out = [];
    for (const [key, dirname] of Object.entries({ plugin: 'plugins', mod: 'mods' })) {
      const { p, root } = resolveIn(mc.SERVERS_DIR, req.params.id, dirname);
      if (p === root) continue;
      if (!fs.existsSync(p)) continue;
      const rows = fs.readdirSync(p, { withFileTypes: true })
        .filter(d => d.isFile() && /\.(jar|disabled)$/i.test(d.name))
        .map(d => {
          try {
            const st = fs.statSync(path.join(p, d.name));
            return { file: d.name, folder: dirname, kind: key, size: st.size, mtime: st.mtimeMs };
          } catch { return null; }
        }).filter(Boolean);
      out.push(...rows);
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json(out);
  } catch (e) { RQ(req, res, e); }
}

// ---- INSTALL: POST /api/servers/:id/plugins/install {slug, kind} ----
async function install(req, res) {
  try {
    const slug = String(req.body.slug || '').replace(/[^a-z0-9._-]/gi, '');
    const kind = KINDS[req.body.kind] ? req.body.kind : 'plugin';
    if (!slug) throw new Error('slug lagbe');
    const srvType = await req2srv(req);
    const srvVer = await req2ver(req);
    const k = kindOf(srvType, kind);
    const dirname = k.dirs[kind === 'mod' ? 'mod' : 'plugin'];
    // version fetch: server er game version + loader match Kore
    const gvf = encodeURIComponent(JSON.stringify([srvVer]));
    const lf = encodeURIComponent(JSON.stringify(k.loaders));
    let vs = [];
    const r1 = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?loaders=${lf}&game_versions=${gvf}`, UA);
    if (r1.ok) vs = await r1.json();
    if (!vs.length) {   // loader ar game version er kono combo nai — game version only try kori
      const r2 = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?loaders=${lf}`, UA);
      if (r2.ok) vs = (await r2.json()).filter(v => (v.game_versions || []).includes(srvVer));
      if (!vs.length) {
        // last try — game version only (loader mismatch hole o kaj kore shetaire)
        const r3 = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?game_versions=${gvf}`, UA);
        if (r3.ok) vs = await r3.json();
      }
    }
    const v = vs[0];
    if (!v) throw new Error(`"${slug}" er ${srvVer} version nai (loaders: ${k.loaders.join('/')})`);
    const f = v.files.find(x => x.primary) || v.files[0];
    if (!f || !f.url) throw new Error('download file nai');
    // path-traversal guard: filename e folder separator ashle underscore (api trust holeo defense)
    const safeName = String(f.filename || '').replace(/[\\/]/g, '_');
    const dir = path.join(mc.SERVERS_DIR, req.params.id, dirname);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, safeName);
    // jar download — streaming, progress push → console log
    mc.pushLog(req.params.id, `[Plugin Market] ${v.name || slug} download hocche (${Math.round((f.size || 0) / 1048576)}MB)...`);
    await modrinthDl(req.params.id, f.url, outPath, f.size);
    mc.pushLog(req.params.id, `[Plugin Market] ✅ ${safeName} installed → /${dirname}/ — server RESTART korle load hobe`);
    res.json({ ok: true, file: safeName, folder: dirname, version: v.version_number, restart: true });
  } catch (e) { RQ(req, res, e); }
}

// ---- DELETE: POST /api/servers/:id/plugins/delete {file, folder} ----
function remove(req, res) {
  try {
    const folder = req.body.folder === 'mods' ? 'mods' : 'plugins';
    const file = String(req.body.file || '').replace(/[/\\]/g, '');
    if (!file || !/\.(jar|disabled)$/i.test(file)) throw new Error('file name vul');
    const { p } = resolveIn(mc.SERVERS_DIR, req.params.id, folder + '/' + file);
    if (!fs.existsSync(p)) throw new Error('file nai');
    fs.rmSync(p);
    mc.pushLog(req.params.id, `[Plugin Market] ❌ ${file} delete holo — restart korle remove hobe`);
    res.json({ ok: true });
  } catch (e) { RQ(req, res, e); }
}

// modrinth streaming download (progress push, 512KB min jar check)
async function modrinthDl(id, url, outPath, expected) {
  const cleanup = () => { try { fs.rmSync(outPath, { force: true }); } catch {} };
  try {
    const r = await fetch(url, { ...UA, redirect: 'follow' });
    if (!r.ok) throw new Error('download fail HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || expected || 0;
    if (!total) fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
    else {
      let got = 0, lastPct = 0;
      const ws = fs.createWriteStream(outPath);
      const src = Readable.fromWeb(r.body);
      await new Promise((resolve, reject) => {
        src.on('data', c => {
          got += c.length;
          if (!ws.write(c)) { src.pause(); ws.once('drain', () => src.resume()); }
          const pct = Math.floor(got / total * 100);
          if (pct >= lastPct + 25) { lastPct = pct; mc.pushLog(id, `[Plugin Market] ${pct}% (${Math.round(got / 1048576)}MB)`); }
        });
        src.on('end', () => ws.end(resolve));
        src.on('error', reject); ws.on('error', reject);
      });
    }
    const st = fs.statSync(outPath);
    if (st.size < 10 * 1024) throw new Error('downloaded file choto — jar broken?');
  } catch (e) {
    cleanup(); // broken jar rekhe dile server crash kore crash-loop hoto
    throw e;
  }
}

// helper — server record type/version ROUTES e set hoy (req.__srvType/__srvVersion)
async function req2srv(req) { return req.__srvType || 'paper'; }
async function req2ver(req) { return req.__srvVersion || '1.21.1'; }

module.exports = { search, listInstalled, install, remove, KINDS };
