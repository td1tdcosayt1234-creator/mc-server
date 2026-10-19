# ⛏️ MC Panel v2.0 — Pterodactyl-style Minecraft Panel

Dashboard + Server Panel + Admin. Pterodactyl panel er moto: real terminal,
file manager, startup/settings edit, backup + restore — sob nijer server hobe gulo.

## Pages
| URL | Ki ache |
|---|---|
| `/` | Dashboard — sob server list + CPU/RAM live |
| `/server/<id>` | **Main server panel** (Pterodactyl-style) |
| `/user` | New server create + list |
| `/admin` | User manage (Firebase) + sob server quick control |

## Server Panel tabs (`/server/<id>`)
- **🖥️ Console** — live SSE terminal, colored logs (INFO gray, WARN yellow, ERROR red,
  chat green, command purple), command input + history (ArrowUp/Down),
  power buttons `Start / Restart / Stop / Kill`, CPU/RAM bar + uptime (PowerShell stats).
- **📁 Files** — puro server folder browse: explorer, text editor (Ctrl+S save),
  multi upload, download, new file/folder, rename, delete.
- **🚀 Startup** — RAM (`-Xmx`), extra Java args, platform/version chip,
  Java version check, EULA accept.
- **⚙️ Settings** — server.properties form editor (motd, port, max-players, difficulty,
  gamemode, whitelist, view-distance...) + raw file mode. Save → Restart korle apply.
- **🌐 Network** — game port, LAN IP, panel URL, join address + port-forward/tunnel note.
- **💾 Backups** — list (size/date), manual backup, Restore (unzip overwrite, stop kore),
  Download, delete. Auto backup proti `BACKUP_MINUTES` min por por.

## Platforms (auto jar download)
Server: Paper (fill v3) • Purpur • Vanilla (Mojang) • Spigot • Fabric • Quilt • Folia • NeoForge • Forge (installer, 1.17+) • CraftBukkit • Leaf (paper fork) • Mohist (Forge+Bukkit hybrid) • Arclight (Forge+Bukkit hybrid)
Proxy: Velocity • Waterfall • BungeeCord (stop command auto: end/shutdown, nogui off)

## Run
```
npm install
npm start
```
```
Home:    http://localhost:3000/
Panel:   http://localhost:3000/server/<server-id>
User:    http://localhost:3000/user
Admin:   http://localhost:3000/admin
```

## API reference (panel ache, scripto baire use korte paro)
```
GET  /api/servers/:id/logs?tail=200      {logs,running}
GET  /api/servers/:id/console            SSE live stream (line event string)
POST /api/servers/:id/command            {cmd:"say hi"}
GET  /api/servers/:id/stats              {cpu,memMB,uptime,running}
POST /api/servers/:id/start|stop|restart|kill
GET  /api/servers/:id/files?dir=         GET /file?path=  POST /file {path,content}
POST /mkdir|/delete|/rename              POST /upload?path= (raw body)  GET /download?path=
GET/POST /api/servers/:id/properties     GET/POST /api/servers/:id/startup
GET  /api/servers/:id/backups            POST /backup  DELETE /backups/:name
POST /api/servers/:id/backups/:name/restore   GET .../backups/:name/download
GET/POST /api/users, DELETE /api/users/:id
```

## Crash protection
- Server crash korle 5s por auto restart + `[Panel] crash detected` log (4 bar crash-loop hole auto-restart OFF)
- Panel reboot korle sob server auto start (jar missing hole nijei re-download)
- Stop = graceful `stop` command (proxy: `end`/`shutdown`), 25s grace er por force kill (taskkill /T /F)

## Firebase (users/servers DB)
1. console.firebase.google.com → Firestore create
2. serviceAccount JSON → root e `serviceAccount.json` rakho
3. `.env`: `FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json`
4. Na thakle local `db.json` use hobe

## Google Drive backup
1. service account + Drive API enable
2. Drive folder id → `.env` `DRIVE_FOLDER_ID`
3. folder share → service account email **Editor**
4. Na thakle local `./backups` e zip (prati server 10 ta limit)

## Notes
- MC 1.20.x = Java 17, 1.20.5+/1.21+ = Java 21
- Firewall: panel port + 25565 TCP open koro
- `servers/`, `backups/`, `*.jar`, `*.zip` git e jay na
