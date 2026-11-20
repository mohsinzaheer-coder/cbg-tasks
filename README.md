# Corporate Brilliance Global — Clients and Employee Tasks Management

A web portal where every employee signs in with their own **Login ID and password**.

| Role | Sees | Can do |
|---|---|---|
| **Owner** | Every partner, every staff member, every business task | Add partners and staff, move staff between partners, assign tasks to anyone, reset passwords, deactivate accounts |
| **Partner** | Their own staff's business tasks, tasks they assigned or are listed on as a partner; all clients (edit the ones they are in charge of) | Add and manage their own staff, assign tasks to partners and staff, follow tasks they are involved in, keep a private feed |
| **Staff** | Only tasks assigned to him, and the clients assigned to him | Mark tasks Started or Done, add a progress note, view the portal logins of his clients. Can add a client (it goes to his partner) and edit that client's details and logins. Cannot archive clients or delete logins, and cannot reassign or delete tasks |

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

## International clients

The **International** tab holds clients outside Pakistan. Each one has country, tax/registration number, contact details and portal logins under any name (HMRC, IRS and so on).
Only the owner and the partners and staff ticked under **People who can see this client** can see the client, its logins and its tasks. The partner in charge always has access.
Tasks for international clients appear on the main Tasks board for those people, marked **Intl**. Use the Client filter's **International only** to show just them.
Someone can only be removed from an international client once their open and recurring tasks for it have been reassigned.

The **Tasks** page has two dashboards, **Local** and **International**, each with its own counts, filters and table.
Each staff member has a **Works on** setting (Local, International, or Both) on the People page. It decides which dashboard they see, which kind of client tasks they can be given, and whether they can be given access to international clients.

## Client portal

On the **Client portal** tab, the owner and partners can give a client their own login. One login can cover several companies, so a client with two or three companies sees all of them on one dashboard.
Clients sign in on the same page as staff. They see, for each company: its registration details, the partner in charge, and every task for it from the last 12 months with category, due date, status, completed date and the **Update for the client**.
To write that update, open a task's **Note** and fill in **Update for the client**. The other note stays internal.
Clients never see portal passwords, internal instructions, progress notes, who is working on a task, other companies, or anything else in the app. Client logins can't open any staff page.
Deactivate or reset a client's password there too; both sign them out straight away. Login IDs must be different from staff login IDs.

## Waiting for the client (hold)

When work can't move until the client sends something, use **Hold for client** on the task and list what's needed (one item per line), with an optional message.
- The task shows **Waiting for client · 2 of 3 pending** and appears under the **Waiting for client** tab.
- The client sees the list under **Pending from your side** on their portal and can tap **Mark as sent**. Your team then sees "Client says 1 sent: please check".
- Tick each item as it reaches you. When everything is received, the hold ends by itself. **End hold** ends it early; marking the task Done ends it too.
- **Copy reminder message** copies a ready-written reminder listing the pending items, to paste into WhatsApp or email.

## Recurring tasks grouped by category

On the Tasks board (table view), recurring tasks are gathered under their category, e.g. **SECP / Corporate** or **Sales Tax**. Each category is one row showing how many are Pending, In progress and Done, a progress bar, and any overdue. Click the row to open the tasks in it, or click **Pending**, **In progress** or **Done** to open just those. Untick **Group recurring by category** to see every task in one list again.

## Sorting and filtering task tables

In table view (Tasks and My feed), click any column heading to sort by it: once for A→Z or earliest first, again to reverse, a third time to go back to the normal order. The row under the headings has a filter for each column: type in Task, Client / Project, Category, Assigned to or Partners, or pick a Priority, Due (Overdue, Due today, Next 7 days, This month, No due date) or Status. **Clear** next to the status tabs resets them.

## Done tasks are locked

When a task is marked **Done**, the date (and who marked it) shows in the **Done on** column. From then on the people who did the task can no longer change its status.
Only the owner, or the partner who assigned the task, can move it back to To do or In progress, and they must give a reason. The reason, who changed it and when are shown on the task. For a task a staff member added for himself, his partner can reopen it. Every status change is recorded.

## Tasks for several people

**Assign to** is a tick list: tick one or more people. A task given to several people is one shared task. Everyone on it sees it and can update its status and notes, and when anyone marks it Done it is done for all.

## Importing recurring tasks from Excel

On **Recurring**, the owner can use **Import from Excel** (.xlsx or .csv). Columns: Task Name, Client Name, Assign To, Partner, Category, Repeat (Weekly / Monthly / Quarterly / Yearly), Due on Day (for Weekly, a weekday such as Friday), Due In Month, Add to board this many days before due. Optional: Authorized Capital, Paid up Capital, Priority, Instructions.
Several people go in one cell separated by commas, and names must match the People page. The import shows a preview first. Rows with a problem are listed and left out. Missing clients and categories are created, and importing the same file again skips what is already set up.

## Importing clients and portal logins

On **Clients**, the owner can use **Import clients** (.xlsx or .csv). Only **Client Name** is required. Optional columns: Client Type, CNIC, NTN, STRN, Email, Phone, Contact Person, Authorized Capital, Paid up Capital, Partner in charge, and logins named like **SECP ID, SECP Password, SECP PIN** (same for FBR, PRA, SRB, KPRA, BRA).
Existing clients are matched by name: their blank details are filled in, and logins in the file replace saved ones (blank cells never erase a saved login). Passwords are never shown in the preview and are saved encrypted, so **CRED_KEY must be set** first.

## My feed and personal tasks

The owner and partners have a **My feed** tab for their own to-dos. Each one is **Business** or **Personal**.
Personal tasks are seen only by the person who added them, not by the owner or anyone else.
Business tasks use the firm's task categories and a client. Personal tasks use your own **personal categories** and a **Project** instead of a client. Both lists are private to you, and each has **+ Add new…** in the form.
The owner and partners can also add a new firm task category straight from the task form with **+ Add new category…**.

## Client portal passwords (CRED_KEY)

Client logins for FBR, PRA, SRB, KPRA, BRA and SECP are stored **encrypted**. The encryption key comes from the `CRED_KEY` setting.

- Set `CRED_KEY` to a long random phrase (at least 30 characters), for example four or five unrelated words plus numbers.
- **Write it down and keep it somewhere safe outside the app.** If it is lost or changed, saved portal passwords can't be opened again; they would have to be re-entered.
- Without `CRED_KEY`, the app works normally but won't save portal passwords (login IDs still save).
- Each time someone shows a password, the app records who and when. The owner and the partner in charge of the client can see this under **Password access log**.

## Recurring tasks

Set up returns once (weekly, monthly, quarterly or yearly) and the app adds each one to the task board a chosen number of days before it's due, titled with the client and the period, e.g. *Sales Tax Return — ABC Ltd — Oct 2026*. For **Weekly**, choose the day of the week (e.g. every Friday); each week's task is named with its date, e.g. *Stock Report — ABC Ltd — 27 Nov 2026*. The quick-start buttons fill typical due days; change the day whenever a deadline is extended or moved by notification.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `./data/cbg.db` | Where the database file is kept |
| `OWNER_USERNAME` / `OWNER_PASSWORD` / `OWNER_NAME` | — | First owner account (used once, on an empty database) |
| `COOKIE_SECURE` | off | Set to `1` when the site runs on HTTPS |
| `CRED_KEY` | — | Encryption key for client portal passwords. Keep a safe copy |
| `TZ_NAME` | `Asia/Karachi` | Time zone used for due dates |

## Backups
Everything is in the database file (`DB_PATH`). Copy that file, together with the `-wal` file next to it if one exists, to a safe place regularly.

## Branding
The CBG logo is in `logo-mark.png` (round mark) and `logo-full.png` (sign-in page). Colours are at the top of `public/styles.css`.

## Using it day to day
1. **Owner:** go to **People → Add person** and add each partner first, then add staff and choose which partner they report to. Each person gets a login ID and a temporary password. Share these privately.
2. **Partners** can add their own staff the same way.
3. Assign work with **+ Assign task**: title, person, priority, due date and instructions.
4. **Staff** sign in, see only their tasks, press **Start** or **Mark done**, and add a progress note.
5. If someone forgets their password, their partner or the owner uses **Reset password**.
