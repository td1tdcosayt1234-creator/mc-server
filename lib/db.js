const fs = require('fs');
const path = require('path');

let admin = null;
let dbFirestore = null;
const LOCAL_DB = path.join(__dirname, '..', 'db.json');

function loadLocal() {
  try {
    if (!fs.existsSync(LOCAL_DB)) fs.writeFileSync(LOCAL_DB, JSON.stringify({ users: [], servers: [] }, null, 2));
    return JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
  } catch { return { users: [], servers: [] }; }
}
function saveLocal(data) {
  fs.writeFileSync(LOCAL_DB, JSON.stringify(data, null, 2));
}

try {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccount.json';
  if (fs.existsSync(saPath)) {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(saPath))) });
    dbFirestore = admin.firestore();
    console.log('[DB] Firebase Firestore connected');
  } else {
    console.log('[DB] serviceAccount.json nai -> local db.json use hobe');
  }
} catch (e) {
  console.log('[DB] Firebase fail, local use:', e.message);
}

async function getServers() {
  if (dbFirestore) {
    const s = await dbFirestore.collection('servers').get();
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return loadLocal().servers;
}
async function saveServer(srv) {
  if (dbFirestore) {
    await dbFirestore.collection('servers').doc(srv.id).set(srv, { merge: true });
    return srv;
  }
  const data = loadLocal();
  const i = data.servers.findIndex(s => s.id === srv.id);
  if (i >= 0) data.servers[i] = srv; else data.servers.push(srv);
  saveLocal(data);
  return srv;
}
async function deleteServer(id) {
  if (dbFirestore) { await dbFirestore.collection('servers').doc(id).delete(); return; }
  const data = loadLocal();
  data.servers = data.servers.filter(s => s.id !== id);
  saveLocal(data);
}
async function getUsers() {
  if (dbFirestore) {
    const s = await dbFirestore.collection('users').get();
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return loadLocal().users;
}
async function saveUser(u) {
  if (dbFirestore) {
    const id = u.id || u.email.replace(/[^a-z0-9]/gi, '_');
    await dbFirestore.collection('users').doc(id).set(u, { merge: true });
    return { id, ...u };
  }
  const data = loadLocal();
  if (!u.id) u.id = 'u_' + Date.now();
  const i = data.users.findIndex(x => x.id === u.id);
  if (i >= 0) data.users[i] = u; else data.users.push(u);
  saveLocal(data);
  return u;
}

module.exports = { getServers, saveServer, deleteServer, getUsers, saveUser, isFirebase: () => !!dbFirestore };
