# Corporate Brilliance Global — Employee Task Management

A web portal where every employee signs in with their own **Login ID and password**.

| Role | Sees | Can do |
|---|---|---|
| **Owner** | Every manager, every staff member, every task | Add managers and staff, move staff between managers, assign tasks to anyone, reset passwords, deactivate accounts |
| **Manager** | Himself and only the staff who report to him | Add staff to his own team, assign tasks to them, edit or delete those tasks, reset their passwords |
| **Staff** | Only tasks assigned to him | Mark tasks Started or Done and add a progress note. Cannot create, edit, reassign or delete tasks |

Every rule is checked on the server, so a staff member cannot see another person's tasks even by tampering with the browser.

**Security built in:** passwords are stored hashed (scrypt), never in plain text. New and reset accounts must choose their own password at first sign-in. Repeated wrong passwords lock that login for 15 minutes. Deactivating someone signs them out everywhere.

The app has **no outside dependencies**. It needs only Node.js 22.13 or newer. All data lives in one SQLite file.

---

## Run it on your computer (to try it)

1. Install Node.js 22 LTS from nodejs.org.
2. Open a terminal in this folder and run:
   ```
   OWNER_USERNAME=owner OWNER_PASSWORD=ChangeMe123 OWNER_NAME="Your Name" npm start
   ```
   On Windows PowerShell:
   ```
   $env:OWNER_USERNAME="owner"; $env:OWNER_PASSWORD="ChangeMe123"; $env:OWNER_NAME="Your Name"; npm start
   ```
3. Open http://localhost:3000 and sign in as `owner`. You'll be asked to set a new password.

The owner account is created only the first time the app starts with an empty database. If you don't set `OWNER_PASSWORD`, a random one is printed in the log.

---

## Put it online

The app needs a host that keeps files between restarts (a *persistent disk* or *volume*), because the database is a file.

### Option A — Railway (easiest)
1. Put this folder in a private GitHub repository.
2. On railway.com: **New Project → Deploy from GitHub repo** and pick it. It will detect the Dockerfile.
3. In the service, add a **Volume** mounted at `/data`.
4. Under **Variables**, add:
   - `OWNER_USERNAME` = your login ID
   - `OWNER_PASSWORD` = a starting password (letters and numbers, 8+ characters)
   - `OWNER_NAME` = your name
   - `COOKIE_SECURE` = `1`
5. Under **Settings → Networking**, click **Generate Domain** (or add your own domain). Railway serves it over HTTPS.

### Option B — Render
Create a **Web Service** from the GitHub repo (Docker). Add a **Persistent Disk** mounted at `/data` (this needs a paid instance; free instances lose data on restart). Set the same variables as above.

### Option C — Your own server (VPS)
```
# Ubuntu, as a normal user with sudo
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
# copy this folder to /opt/cbg-tasks, then:
cd /opt/cbg-tasks
sudo DB_PATH=/var/lib/cbg/cbg.db OWNER_USERNAME=owner OWNER_PASSWORD=ChangeMe123 PORT=3000 node --no-warnings server.js
```
Run it as a service (systemd or pm2) and put Nginx or Caddy in front for HTTPS. Caddy gets a free certificate automatically: `your-domain.com { reverse_proxy localhost:3000 }`. Set `COOKIE_SECURE=1` once HTTPS is on.

**Always use HTTPS in production**, so passwords are encrypted on the way to the server.

---

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `./data/cbg.db` | Where the database file is kept |
| `OWNER_USERNAME` / `OWNER_PASSWORD` / `OWNER_NAME` | — | First owner account (used once, on an empty database) |
| `COOKIE_SECURE` | off | Set to `1` when the site runs on HTTPS |

## Backups
Everything is in the database file (`DB_PATH`). Copy that file, together with the `-wal` file next to it if one exists, to a safe place regularly.

## Branding
Replace `public/logo.svg` with your company logo. Colours are at the top of `public/styles.css`.

## Using it day to day
1. **Owner:** go to **People → Add person** and add each manager first, then add staff and choose who they report to. Each person gets a login ID and a temporary password. Share these privately.
2. **Managers** can add their own staff the same way.
3. Assign work with **+ Assign task**: title, person, priority, due date and instructions.
4. **Staff** sign in, see only their tasks, press **Start** or **Mark done**, and add a progress note.
5. If someone forgets their password, their manager or the owner uses **Reset password**.
