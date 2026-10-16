# ⛏️ MC Panel - Full Real Panel

Home + User Panel + Admin Panel. Real terminal (live console + command),
auto-download sob platform, Firebase DB, Google Drive auto backup.

## Platforms (auto download)
- Paper (fill v3 API)
- Purpur (`api.purpurmc.org`)
- Vanilla (Mojang piston-meta)
- Spigot (GetBukkit)
- Fabric (meta.fabricmc.net)

User panel theke type + version select korlei `server.jar` auto download,
`eula.txt` auto accept.

## Run
```
npm install
npm start
```
- Home: http://localhost:3000/
- User: http://localhost:3000/user
- Admin: http://localhost:3000/admin

## Real terminal
- `GET /api/servers/:id/logs?tail=150` - last logs
- `GET /api/servers/:id/console` - live SSE stream
- `POST /api/servers/:id/command` - `{cmd}` send

Crash hoile 5s por auto restart, panel reboot hoile sob server auto start.

## Firebase (User/Admin database)
1. console.firebase.google.com > Firestore create
2. Service account JSON -> `serviceAccount.json` ei folder e rakho
3. `.env` e `FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json`
4. Na thakle local `db.json`

## Google Drive backup (proti 50 min)
1. Drive API enable + service account JSON
2. Drive folder banao, service account email ke Editor share daw
3. `.env`:
```
DRIVE_FOLDER_ID=tomar_folder_id
BACKUP_MINUTES=50
```
Na thakle local `./backups` e zip.

## Note
- `servers/`, `backups/`, `node_modules/`, `.env`, `*.jar` git e jay na
- MC 1.20.x = Java 17 ok, 1.21+ = Java 21 lagbe
- Firewall: 3000 (panel) + 25565 (minecraft) TCP open koro
