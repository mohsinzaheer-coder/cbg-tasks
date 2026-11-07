'use strict';
/*
 * Corporate Brilliance Global — Clients and Employee Tasks Management
 * Zero-dependency Node.js server (Node 22.13+): node:http, node:sqlite, node:crypto.
 *
 * Roles
 *   owner   — sees and manages everyone, every client and every task
 *   partner — sees business tasks of his own staff, tasks he assigned or is listed on, and all clients;
 *             staff report to a partner (version 2.4 merged the former manager role into partner)
 *   staff   — sees only his own tasks and the clients assigned to him
 * Every rule below is enforced here on the server, never only in the browser.
 *
 * Client portal passwords (FBR, PRA, SRB, KPRA, BRA, SECP) are encrypted with AES-256-GCM
 * using a key derived from the CRED_KEY environment variable. Every reveal is logged.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cbg.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = process.env.TZ_NAME || 'Asia/Karachi';
const SESSION_DAYS = 7;
const COOKIE = 'cbg_sid';
const AUTHORITIES = ['FBR', 'PRA', 'SRB', 'KPRA', 'BRA', 'SECP'];
const ENTITY_TYPES = ['Individual', 'AOP', 'Company', 'Other'];

/* ------------------------------------------------------------------ DB */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('owner','partner','manager','staff')),
  manager_id    INTEGER REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  due          TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  progress     TEXT NOT NULL DEFAULT '',
  assignee_id  INTEGER NOT NULL REFERENCES users(id),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id),
  done_at      INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS clients (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL DEFAULT '',
  entity_type    TEXT NOT NULL DEFAULT 'Company',
  ntn            TEXT NOT NULL DEFAULT '',
  strn           TEXT NOT NULL DEFAULT '',
  cnic           TEXT NOT NULL DEFAULT '',
  contact_person TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  manager_id     INTEGER REFERENCES users(id),
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS client_staff (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (client_id, user_id)
);
CREATE TABLE IF NOT EXISTS client_logins (
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  authority  TEXT NOT NULL,
  login_id   TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL DEFAULT '',
  pin_enc    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (client_id, authority)
);
CREATE TABLE IF NOT EXISTS secret_views (
  id        INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  authority TEXT NOT NULL,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  viewed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recurring (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  frequency   TEXT NOT NULL CHECK (frequency IN ('monthly','quarterly','annual')),
  due_day     INTEGER NOT NULL,
  due_month   INTEGER,
  months      TEXT NOT NULL DEFAULT '',
  lead_days   INTEGER NOT NULL DEFAULT 10,
  priority    TEXT NOT NULL DEFAULT 'high',
  notes       TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  last_due    TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
`);
// Upgrade an existing tasks table from version 1 without losing data
{
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  const add = (c, def) => { if (!cols.includes(c)) db.exec(`ALTER TABLE tasks ADD COLUMN ${c} ${def}`); };
  add('category_id', 'INTEGER REFERENCES categories(id) ON DELETE SET NULL');
  add('client_id', 'INTEGER REFERENCES clients(id) ON DELETE SET NULL');
  add('recurring_id', 'INTEGER REFERENCES recurring(id) ON DELETE SET NULL');
  add('period', "TEXT NOT NULL DEFAULT ''");
  add('visibility', "TEXT NOT NULL DEFAULT 'business'");
  db.exec('CREATE INDEX IF NOT EXISTS tasks_client ON tasks(client_id)');
  const rcols = db.prepare('PRAGMA table_info(recurring)').all().map(c => c.name);
  if (!rcols.includes('partner_ids')) db.exec("ALTER TABLE recurring ADD COLUMN partner_ids TEXT NOT NULL DEFAULT ''");
}
// Version 2.3: allow the 'partner' role. SQLite can't change a CHECK rule in place, so rebuild users keeping every row and id.
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
  if (!sql.includes("'partner'")) {
    const hasDeleted = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'deleted');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK (role IN ('owner','partner','manager','staff')),
        manager_id INTEGER REFERENCES users(id), active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
      db.exec(`INSERT INTO users_new (id,username,password_hash,name,title,role,manager_id,active,must_change,created_at,deleted)
               SELECT id,username,password_hash,name,title,role,manager_id,active,must_change,created_at,${hasDeleted ? 'deleted' : '0'} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
    console.log('Database upgraded: partner role added.');
  }
}
// Version 2.4: the manager role is retired; every manager becomes a partner and keeps their staff and clients.
{
  const r = db.prepare("UPDATE users SET role = 'partner' WHERE role = 'manager'").run();
  if (r.changes) console.log(`Database upgraded: ${r.changes} manager(s) are now partners.`);
}
// Version 2.9: international clients. They carry country and tax ID, and only the people in client_access (plus the owner) can see them.
{
  const cols = db.prepare('PRAGMA table_info(clients)').all().map(c => c.name);
  if (!cols.includes('scope')) db.exec("ALTER TABLE clients ADD COLUMN scope TEXT NOT NULL DEFAULT 'local'");
  if (!cols.includes('country')) db.exec("ALTER TABLE clients ADD COLUMN country TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('tax_id')) db.exec("ALTER TABLE clients ADD COLUMN tax_id TEXT NOT NULL DEFAULT ''");
}
// Version 2.10: staff work on local clients, international clients, or both
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'work_area')) {
  db.exec("ALTER TABLE users ADD COLUMN work_area TEXT NOT NULL DEFAULT 'local'");
  db.exec("UPDATE users SET work_area = 'both' WHERE role <> 'staff'");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'client_access'").get())
    db.exec("UPDATE users SET work_area = 'both' WHERE id IN (SELECT user_id FROM client_access)");
}
db.exec(`CREATE TABLE IF NOT EXISTS client_access (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (client_id, user_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS task_partners (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
)`);
if (db.prepare('SELECT COUNT(*) n FROM categories').get().n === 0) {
  const ins = db.prepare('INSERT INTO categories (name) VALUES (?)');
  for (const c of ['Sales Tax', 'Withholding Tax', 'Income Tax', 'Annex H', 'Provincial Sales Tax', 'SECP / Corporate', 'Bookkeeping', 'Payroll', 'Audit', 'Other']) ins.run(c);
}

/* -------------------------------------------------------- local dates */
function localToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const pad = n => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------- client secrets */
const CRED_KEY = process.env.CRED_KEY ? crypto.scryptSync(process.env.CRED_KEY, 'cbg-client-logins-v1', 32) : null;
(function checkKey() {
  if (!CRED_KEY) { console.log('NOTE: CRED_KEY is not set. Saving client portal passwords is switched off.'); return; }
  const fp = crypto.createHash('sha256').update(CRED_KEY).digest('hex').slice(0, 16);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cred_key_fp'").get();
  if (!row) db.prepare("INSERT INTO settings VALUES ('cred_key_fp', ?)").run(fp);
  else if (row.value !== fp) console.error('WARNING: CRED_KEY differs from the one used to save client passwords. Saved passwords cannot be opened until the original CRED_KEY is restored.');
})();
function encrypt(text) {
  if (!text) return '';
  if (!CRED_KEY) throw new HttpError(503, 'Client passwords are switched off until CRED_KEY is set on the server.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CRED_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(blob) {
  if (!blob) return '';
  if (!CRED_KEY) throw new HttpError(503, 'Client passwords are switched off until CRED_KEY is set on the server.');
  try {
    const [, iv, tag, ct] = blob.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', CRED_KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { throw new HttpError(500, 'This password can\'t be opened. The server\'s CRED_KEY was changed.'); }
}

/* ------------------------------------------------------------ passwords */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = Buffer.from(k, 'base64');
  const test = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number.';
  return null;
}

/* --------------------------------------------------------- first owner */
(function seedOwner() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return;
  const username = (process.env.OWNER_USERNAME || 'owner').trim();
  let password = process.env.OWNER_PASSWORD; let generated = false;
  if (!password || passwordProblem(password)) { password = 'Cbg-' + crypto.randomBytes(6).toString('base64url') + '7'; generated = true; }
  db.prepare(`INSERT INTO users (username,password_hash,name,title,role,must_change,created_at) VALUES (?,?,?,?, 'owner', 1, ?)`)
    .run(username, hashPassword(password), process.env.OWNER_NAME || 'Owner', 'Owner', Date.now());
  console.log('\n=== Owner account created ===');
  console.log('Login ID :', username);
  console.log('Password :', generated ? password : '(the OWNER_PASSWORD you set)');
  console.log('You will be asked to choose a new password at first sign-in.\n');
})();

/* ------------------------------------------------------------- sessions */
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { } }
  }
  return out;
}
function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(token));
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return row;
}
const isHttps = req => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
function setCookie(res, req, token, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (isHttps(req) ? '; Secure' : ''));
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

/* ---------------------------------------------------- login rate limits */
const attempts = new Map();
const limited = key => { const a = attempts.get(key); return a && a.count >= 5 && a.until > Date.now(); };
function fail(key) { const a = attempts.get(key); if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 15 * 60e3 }); else a.count++; }

/* ---------------------------------------------------------- permissions */
const publicUser = u => u && ({ id: u.id, username: u.username, name: u.name, title: u.title, role: u.role, managerId: u.manager_id, active: !!u.active, mustChange: !!u.must_change, workArea: u.role === 'staff' ? (u.work_area || 'local') : 'both' });
const WORK_AREAS = ['local', 'intl', 'both'];
const AREA_LABEL = { local: 'local clients only', intl: 'international clients only' };
// A staff member's work area must cover the kind of client the work is for
function checkWorkArea(clientId, userIds) {
  if (!clientId) return;
  const c = db.prepare('SELECT scope FROM clients WHERE id = ?').get(clientId); if (!c) return;
  const kind = c.scope === 'intl' ? 'intl' : 'local';
  for (const uid of new Set(userIds.filter(Boolean))) {
    const u = db.prepare('SELECT name, role, work_area FROM users WHERE id = ?').get(uid);
    if (u && u.role === 'staff' && u.work_area !== 'both' && u.work_area !== kind)
      throw bad(`${u.name} works on ${AREA_LABEL[u.work_area]}. Change their "Works on" setting on People, or choose someone else.`);
  }
}
function teamIds(me) {
  if (me.role === 'owner') return null;
  if (me.role === 'partner' || me.role === 'manager') return [me.id, ...db.prepare("SELECT id FROM users WHERE manager_id = ? AND role = 'staff'").all(me.id).map(r => r.id)];
  return [me.id];
}
function canManageUser(me, target) {
  if (!target || target.deleted) return false;
  if (me.role === 'owner') return true;
  if (me.role === 'partner') return target.role === 'staff' && target.manager_id === me.id;
  return false;
}
/* Clients this person may see
 *   local clients — owner and partners: all (partners edit the ones they are in charge of); staff: the ones assigned to them
 *   international clients — only the owner and the people listed on the client */
function visibleClientIds(me) {
  if (me.role === 'owner') return null;
  const intl = db.prepare("SELECT ca.client_id id FROM client_access ca JOIN clients c ON c.id = ca.client_id WHERE ca.user_id = ? AND c.scope = 'intl'").all(me.id).map(r => r.id);
  const local = me.role === 'partner'
    ? db.prepare("SELECT id FROM clients WHERE scope <> 'intl'").all().map(r => r.id)
    : db.prepare("SELECT cs.client_id id FROM client_staff cs JOIN clients c ON c.id = cs.client_id WHERE cs.user_id = ? AND c.scope <> 'intl'").all(me.id).map(r => r.id);
  return [...new Set([...local, ...intl])];
}
// Tasks and recurring tasks for an international client are hidden from anyone not listed on that client
function intlCtx(me) {
  return {
    intl: new Set(db.prepare("SELECT id FROM clients WHERE scope = 'intl'").all().map(r => r.id)),
    mine: new Set(db.prepare('SELECT client_id FROM client_access WHERE user_id = ?').all(me.id).map(r => r.client_id)),
  };
}
function intlHidden(me, clientId, ctx) {
  if (me.role === 'owner' || !clientId) return false;
  ctx = ctx || intlCtx(me);
  return ctx.intl.has(clientId) && !ctx.mine.has(clientId);
}
// Everyone working on or following a task for an international client must be listed on that client
function checkIntlPeople(clientId, people) {
  if (!clientId) return;
  const c = db.prepare('SELECT scope, name FROM clients WHERE id = ?').get(clientId);
  if (!c || c.scope !== 'intl') return;
  for (const uid of new Set(people.filter(Boolean))) {
    const u = db.prepare('SELECT name, role FROM users WHERE id = ?').get(uid);
    if (!u || u.role === 'owner') continue;
    if (!db.prepare('SELECT 1 FROM client_access WHERE client_id = ? AND user_id = ?').get(clientId, uid))
      throw bad(`${u.name} can't see the international client ${c.name}. Add them to that client's people first.`);
  }
}
function canSeeClient(me, c) { if (!c) return false; const ids = visibleClientIds(me); return ids === null || ids.includes(c.id); }
function canEditClient(me, c) { return me.role === 'owner' || (me.role === 'partner' && c.manager_id === me.id); }

/* Task visibility
 *   personal — only the person who created it, nobody else (the owner included)
 *   business — owner: all; anyone: tasks assigned to or created by them;
 *              partner: also tasks they are listed on as an involved partner;
 *              manager: also tasks of their own staff */
function partnerMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT tp.task_id, tp.user_id, u.name FROM task_partners tp JOIN users u ON u.id = tp.user_id ORDER BY u.name').all()) {
    if (!m.has(r.task_id)) m.set(r.task_id, []);
    m.get(r.task_id).push({ id: r.user_id, name: r.name });
  }
  return m;
}
const taskPartners = id => db.prepare('SELECT tp.user_id id, u.name FROM task_partners tp JOIN users u ON u.id = tp.user_id WHERE tp.task_id = ? ORDER BY u.name').all(id);
function visibleTask(me, t, partners, ctx) {
  if (!t) return false;
  if (t.visibility === 'personal') return t.created_by === me.id;
  if (intlHidden(me, t.client_id, ctx)) return false;
  if (me.role === 'owner' || t.assignee_id === me.id || t.created_by === me.id) return true;
  if (me.role === 'partner') return teamIds(me).includes(t.assignee_id) || (partners ?? taskPartners(t.id)).some(p => p.id === me.id);
  return false;
}
function canEditTask(me, t) {
  if (t.visibility === 'personal') return t.created_by === me.id;
  if (me.role === 'owner' || t.created_by === me.id) return true;
  if (me.role === 'partner' && t.assignee_id === me.id) return true; // a partner can pass work given to him on to his staff
  if (me.role === 'partner') return t.assignee_id !== me.id && teamIds(me).includes(t.assignee_id);
  return false;
}
function taskOut(t, me, partners) {
  const ps = partners ?? taskPartners(t.id);
  return {
    id: t.id, title: t.title, notes: t.notes, priority: t.priority, due: t.due, status: t.status, progress: t.progress,
    assigneeId: t.assignee_id, assigneeName: t.assignee_name, createdBy: t.created_by, createdByName: t.creator_name,
    categoryId: t.category_id, categoryName: t.category_name || '', clientId: t.client_id, clientName: t.client_name || '',
    recurringId: t.recurring_id, period: t.period, visibility: t.visibility || 'business',
    partnerIds: ps.map(p => p.id), partnerNames: ps.map(p => p.name),
    createdAt: t.created_at, updatedAt: t.updated_at, doneAt: t.done_at, canEdit: canEditTask(me, t),
    canDelete: canDeleteTask(me, t), selfAdded: t.created_by === t.assignee_id,
  };
}
// Deleting stays with the owner, the person who created the task, and the partner over the assignee
function canDeleteTask(me, t) {
  if (me.role === 'staff') return false;
  if (t.visibility === 'personal') return t.created_by === me.id;
  if (me.role === 'owner' || t.created_by === me.id) return true;
  return me.role === 'partner' && t.assignee_id !== me.id && teamIds(me).includes(t.assignee_id);
}
function checkPartners(list, excludeId) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('Partners list is not valid.');
  const ids = [...new Set(list.map(Number))].filter(id => id !== excludeId);
  for (const id of ids) if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role IN ('partner','owner') AND active = 1 AND deleted = 0").get(id)) throw bad('One of the chosen partners is not active.');
  return ids;
}
function setTaskPartners(taskId, ids) {
  db.prepare('DELETE FROM task_partners WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT INTO task_partners (task_id, user_id) VALUES (?,?)'); for (const id of ids) ins.run(taskId, id);
}
const TASK_SELECT = `SELECT t.*, a.name assignee_name, c.name creator_name, k.name category_name, cl.name client_name FROM tasks t
  JOIN users a ON a.id = t.assignee_id JOIN users c ON c.id = t.created_by
  LEFT JOIN categories k ON k.id = t.category_id LEFT JOIN clients cl ON cl.id = t.client_id`;

/* ------------------------------------------------------------- helpers */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);
const str = (v, max, field) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  v = v.trim(); if (v.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return v;
};
const isDate = v => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
const intOrNull = v => (v === '' || v == null) ? null : Number.isInteger(Number(v)) ? Number(v) : NaN;
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 128 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
      catch { reject(bad('Invalid request body.')); }
    });
    req.on('error', reject);
  });
}
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

/* --------------------------------------------------------------- routes */
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({
  method, auth, fn,
  re: new RegExp('^' + pattern.replace(/:auth\b/, '(?<auth>[^/]+)').replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'),
});

/* ---- session ---- */
route('POST', '/api/login', false, async (req, res, body) => {
  const username = str(body.username, 60, 'Login ID'); const password = typeof body.password === 'string' ? body.password : '';
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const key = ip + '|' + username.toLowerCase();
  if (limited(key)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && u && u.active;
  if (!ok) { fail(key); throw new HttpError(401, 'Login ID or password is incorrect.'); }
  attempts.delete(key);
  setCookie(res, req, createSession(u.id), SESSION_DAYS * 86400);
  send(res, 200, { user: publicUser(u) });
});
route('POST', '/api/logout', false, async (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  setCookie(res, req, '', 0); send(res, 200, { ok: true });
});
route('GET', '/api/me', true, async (req, res, body, me) => send(res, 200, { user: publicUser(me), config: { credsEnabled: !!CRED_KEY, authorities: AUTHORITIES, entityTypes: ENTITY_TYPES, today: localToday() } }));
route('POST', '/api/me/password', true, async (req, res, body, me) => {
  if (!verifyPassword(String(body.current || ''), me.password_hash)) throw bad('Current password is incorrect.');
  const p = passwordProblem(body.next); if (p) throw bad(p);
  if (body.next === body.current) throw bad('Choose a password different from the current one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(body.next), me.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(me.id, sha(parseCookies(req)[COOKIE]));
  send(res, 200, { ok: true });
});

/* ---- people ---- */
route('GET', '/api/users', true, async (req, res, body, me) => {
  let rows;
  // Partners can assign to anyone, so they see everyone. Managers also see partners, to list them on tasks.
  if (me.role === 'owner' || me.role === 'partner') rows = db.prepare('SELECT * FROM users WHERE deleted = 0 ORDER BY role, name').all();
  else if (me.role === 'manager') rows = db.prepare("SELECT * FROM users WHERE deleted = 0 AND (id = ? OR (manager_id = ? AND role = 'staff') OR (role = 'partner' AND active = 1)) ORDER BY name").all(me.id, me.id);
  else rows = [me];
  send(res, 200, { users: rows.map(publicUser) });
});
route('POST', '/api/users', true, async (req, res, body, me) => {
  if (me.role !== 'owner' && me.role !== 'partner') throw new HttpError(403, 'Only the owner and partners can add people.');
  const name = str(body.name, 80, 'Name'); const username = str(body.username, 40, 'Login ID'); const title = str(body.title, 60, 'Job title');
  const role = me.role === 'owner' ? body.role : 'staff';
  if (!name) throw bad('Enter a name.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw bad('Login ID must be 3–40 letters, numbers, dots, dashes or underscores.');
  if (!['partner', 'staff'].includes(role)) throw bad('Role must be partner or staff.');
  const p = passwordProblem(body.password); if (p) throw bad(p);
  let managerId = null;
  if (role === 'staff') {
    managerId = me.role === 'partner' ? me.id : Number(body.managerId);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'partner' AND active = 1 AND deleted = 0").get(managerId)) throw bad('Choose the partner this staff member reports to.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That login ID is already taken.');
  const area = role === 'staff' ? (WORK_AREAS.includes(body.workArea) ? body.workArea : 'local') : 'both';
  const r = db.prepare('INSERT INTO users (username,password_hash,name,title,role,manager_id,must_change,created_at,work_area) VALUES (?,?,?,?,?,?,1,?,?)')
    .run(username, hashPassword(body.password), name, title, role, managerId, Date.now(), area);
  send(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
});
route('PATCH', '/api/users/:id', true, async (req, res, body, me, params) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!canManageUser(me, target) || (target.id === me.id && me.role !== 'owner')) throw new HttpError(404, 'Person not found.');
  const sets = {};
  if ('name' in body) { const n = str(body.name, 80, 'Name'); if (!n) throw bad('Enter a name.'); sets.name = n; }
  if ('title' in body) sets.title = str(body.title, 60, 'Job title');
  if ('workArea' in body && target.role === 'staff') {
    if (!WORK_AREAS.includes(body.workArea)) throw bad('Choose Local, International or Both.');
    const losing = body.workArea === 'local' ? 'intl' : body.workArea === 'intl' ? 'local' : null;
    if (losing) {
      const open = db.prepare(`SELECT COUNT(*) n FROM tasks t JOIN clients c ON c.id = t.client_id WHERE t.assignee_id = ? AND t.status <> 'done' AND ${losing === 'intl' ? "c.scope = 'intl'" : "c.scope <> 'intl'"}`).get(target.id).n;
      if (open) throw bad(`${target.name} still has ${open} open ${losing === 'intl' ? 'international' : 'local'} task${open === 1 ? '' : 's'}. Reassign them first.`);
      if (losing === 'intl' && db.prepare('SELECT 1 FROM client_access WHERE user_id = ?').get(target.id)) db.prepare('DELETE FROM client_access WHERE user_id = ?').run(target.id);
    }
    sets.work_area = body.workArea;
  }
  if ('username' in body) {
    const u = str(body.username, 40, 'Login ID');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(u)) throw bad('Login ID must be 3–40 letters, numbers, dots, dashes or underscores.');
    const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
    if (ex && ex.id !== target.id) throw bad('That login ID is already taken.');
    sets.username = u;
  }
  if ('password' in body) { const p = passwordProblem(body.password); if (p) throw bad(p); sets.password_hash = hashPassword(body.password); sets.must_change = 1; }
  if ('active' in body) {
    if (target.id === me.id) throw bad('You cannot deactivate your own account.');
    if (target.role === 'partner' && !body.active && db.prepare('SELECT 1 FROM users WHERE manager_id = ? AND active = 1 AND deleted = 0').get(target.id)) throw bad('Move this partner\'s staff to another partner first.');
    sets.active = body.active ? 1 : 0;
  }
  if ('managerId' in body) {
    if (me.role !== 'owner' || target.role !== 'staff') throw new HttpError(403, 'Only the owner can move staff between partners.');
    const m = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'partner' AND active = 1 AND deleted = 0").get(Number(body.managerId));
    if (!m) throw bad('Choose an active partner.');
    sets.manager_id = m.id;
  }
  const keys = Object.keys(sets);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), target.id);
  if ('password' in body || sets.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  send(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});

// Delete an employee. Open tasks, recurring tasks and clients pass to `transferTo`.
// The record is kept (hidden) so completed tasks and the password access log keep their names.
route('DELETE', '/api/users/:id', true, async (req, res, body, me, params) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!canManageUser(me, target) || target.id === me.id) throw new HttpError(404, 'Person not found.');
  if (target.role === 'owner') throw bad('The owner account cannot be deleted.');
  if (target.role === 'partner' && db.prepare('SELECT 1 FROM users WHERE manager_id = ? AND deleted = 0').get(target.id))
    throw bad('Move this partner\'s staff to another partner first.');
  const n = sql => db.prepare(sql).get(target.id).n;
  // Personal tasks are never handed over; they stay private and hidden.
  const openTasks = n("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status <> 'done' AND visibility = 'business'");
  const rules = n('SELECT COUNT(*) n FROM recurring WHERE assignee_id = ?');
  const managed = n('SELECT COUNT(*) n FROM clients WHERE manager_id = ?');
  const assigned = n('SELECT COUNT(*) n FROM client_staff WHERE user_id = ?');
  let to = null;
  if (openTasks || rules || managed || assigned) {
    to = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND deleted = 0').get(Number(body.transferTo));
    if (!to || to.id === target.id || to.role === 'owner') throw bad('Choose who takes over their open work and clients.');
    const team = teamIds(me);
    if (team && !team.includes(to.id)) throw bad('Choose someone in your own team.');
    if (target.role === 'partner' && to.role !== 'partner') throw bad('Choose another partner to take over.');
  }
  tx(() => {
    if (to) {
      db.prepare("UPDATE tasks SET assignee_id = ?, updated_at = ?, updated_by = ? WHERE assignee_id = ? AND status <> 'done' AND visibility = 'business'").run(to.id, Date.now(), me.id, target.id);
      db.prepare('UPDATE recurring SET assignee_id = ? WHERE assignee_id = ?').run(to.id, target.id);
      if (managed) db.prepare('UPDATE clients SET manager_id = ?, updated_at = ? WHERE manager_id = ?').run(to.id, Date.now(), target.id);
      if (to.role === 'staff') db.prepare('INSERT OR IGNORE INTO client_staff (client_id, user_id) SELECT client_id, ? FROM client_staff WHERE user_id = ?').run(to.id, target.id);
      if (to.role === 'partner') {
        db.prepare("INSERT OR IGNORE INTO task_partners (task_id, user_id) SELECT tp.task_id, ? FROM task_partners tp JOIN tasks t ON t.id = tp.task_id WHERE tp.user_id = ? AND t.status <> 'done'").run(to.id, target.id);
        for (const r of db.prepare("SELECT id, partner_ids FROM recurring WHERE partner_ids <> ''").all()) {
          const ids = r.partner_ids.split(',').map(Number);
          if (ids.includes(target.id)) db.prepare('UPDATE recurring SET partner_ids = ? WHERE id = ?').run([...new Set(ids.map(i => i === target.id ? to.id : i))].join(','), r.id);
        }
      }
    }
    db.prepare("DELETE FROM task_partners WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE status <> 'done')").run(target.id);
    if (to) db.prepare('INSERT OR IGNORE INTO client_access (client_id, user_id) SELECT client_id, ? FROM client_access WHERE user_id = ?').run(to.id, target.id);
    db.prepare('DELETE FROM client_access WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    db.prepare('UPDATE users SET deleted = 1, active = 0, username = ? WHERE id = ?').run(`deleted-${target.id}-${target.username}`.slice(0, 60), target.id);
  });
  send(res, 200, { ok: true, moved: { openTasks, rules, clients: managed + assigned }, to: to ? to.name : null });
});

/* ---- categories ---- */
route('GET', '/api/categories', true, async (req, res) => send(res, 200, { categories: db.prepare('SELECT id, name FROM categories ORDER BY name').all() }));
route('POST', '/api/categories', true, async (req, res, body, me) => {
  if (me.role !== 'owner') throw new HttpError(403, 'Only the owner can change categories.');
  const name = str(body.name, 50, 'Category'); if (!name) throw bad('Enter a category name.');
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) throw bad('That category already exists.');
  const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  send(res, 201, { category: { id: Number(r.lastInsertRowid), name } });
});
route('DELETE', '/api/categories/:id', true, async (req, res, body, me, params) => {
  if (me.role !== 'owner') throw new HttpError(403, 'Only the owner can change categories.');
  db.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').run(Number(params.id));
  db.prepare('UPDATE recurring SET category_id = NULL WHERE category_id = ?').run(Number(params.id));
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(params.id));
  send(res, 200, { ok: true });
});

/* ---- clients ---- */
function clientOut(c, me) {
  const staffIds = db.prepare('SELECT user_id FROM client_staff WHERE client_id = ?').all(c.id).map(r => r.user_id);
  const logins = db.prepare('SELECT authority, login_id, secret_enc, pin_enc, updated_at FROM client_logins WHERE client_id = ?').all(c.id)
    .map(l => ({ authority: l.authority, loginId: l.login_id, hasPassword: !!l.secret_enc, hasPin: !!l.pin_enc, updatedAt: l.updated_at }));
  return {
    id: c.id, name: c.name, code: c.code, entityType: c.entity_type, ntn: c.ntn, strn: c.strn, cnic: c.cnic,
    contactPerson: c.contact_person, phone: c.phone, email: c.email, notes: c.notes, managerId: c.manager_id,
    managerName: c.manager_name || '', active: !!c.active, staffIds, logins, canEdit: canEditClient(me, c),
    scope: c.scope === 'intl' ? 'intl' : 'local', country: c.country || '', taxId: c.tax_id || '',
    accessIds: c.scope === 'intl' ? db.prepare('SELECT user_id FROM client_access WHERE client_id = ?').all(c.id).map(r => r.user_id) : [],
  };
}
const CLIENT_SELECT = 'SELECT c.*, m.name manager_name FROM clients c LEFT JOIN users m ON m.id = c.manager_id';
function getClient(id) { return db.prepare(CLIENT_SELECT + ' WHERE c.id = ?').get(Number(id)); }

route('GET', '/api/clients', true, async (req, res, body, me) => {
  const ids = visibleClientIds(me);
  const rows = ids === null ? db.prepare(CLIENT_SELECT + ' ORDER BY c.name').all()
    : ids.length ? db.prepare(`${CLIENT_SELECT} WHERE c.id IN (${ids.map(() => '?').join(',')}) ORDER BY c.name`).all(...ids) : [];
  send(res, 200, { clients: rows.map(c => clientOut(c, me)) });
});

function clientFields(body, me, existing) {
  const f = {};
  const map = { name: ['name', 120, 'Client name'], code: ['code', 30, 'Client code'], ntn: ['ntn', 30, 'NTN'], strn: ['strn', 30, 'STRN'], cnic: ['cnic', 20, 'CNIC'],
    contactPerson: ['contact_person', 80, 'Contact person'], phone: ['phone', 40, 'Phone'], email: ['email', 120, 'Email'], notes: ['notes', 2000, 'Notes'],
    country: ['country', 60, 'Country'], taxId: ['tax_id', 40, 'Tax ID'] };
  for (const [k, [col, max, label]] of Object.entries(map)) if (k in body) f[col] = str(body[k], max, label);
  if ('name' in f && !f.name) throw bad('Enter the client name.');
  if ('entityType' in body) { if (!ENTITY_TYPES.includes(body.entityType)) throw bad('Choose a client type.'); f.entity_type = body.entityType; }
  if ('managerId' in body) {
    if (me.role !== 'owner') { if (Number(body.managerId) !== me.id) throw new HttpError(403, 'Only the owner can put another partner in charge of a client.'); }
    const mid = intOrNull(body.managerId);
    if (mid !== null && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'partner' AND active = 1 AND deleted = 0").get(mid)) throw bad('Choose an active partner.');
    f.manager_id = mid;
  }
  if ('active' in body) { if (me.role !== 'owner') throw new HttpError(403, 'Only the owner can archive clients.'); f.active = body.active ? 1 : 0; }
  return f;
}
function setClientAccess(clientId, ids, managerId) {
  if (!Array.isArray(ids)) throw bad('People list is not valid.');
  const set = new Set(ids.map(Number)); if (managerId) set.add(managerId); // the partner in charge always has access
  for (const id of set) {
    const u = db.prepare("SELECT name, role, work_area FROM users WHERE id = ? AND role IN ('partner','staff') AND active = 1 AND deleted = 0").get(id);
    if (!u) throw bad('One of the chosen people is not active.');
    if (u.role === 'staff' && u.work_area === 'local') throw bad(`${u.name} works on local clients only. Change their "Works on" setting on People first.`);
  }
  db.prepare('DELETE FROM client_access WHERE client_id = ?').run(clientId);
  const ins = db.prepare('INSERT INTO client_access (client_id, user_id) VALUES (?,?)'); for (const id of set) ins.run(clientId, id);
}
function setClientStaff(me, clientId, managerId, staffIds) {
  if (!Array.isArray(staffIds)) throw bad('Staff list is not valid.');
  const ids = [...new Set(staffIds.map(Number))];
  for (const id of ids) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'staff' AND active = 1").get(id);
    if (!u) throw bad('One of the chosen staff members is not active.');
    if (u.work_area === 'intl') throw bad(`${u.name} works on international clients only.`);
    if (me.role === 'partner' && u.manager_id !== me.id) throw bad('You can only assign your own staff.');
  }
  db.prepare('DELETE FROM client_staff WHERE client_id = ?').run(clientId);
  const ins = db.prepare('INSERT INTO client_staff VALUES (?,?)'); for (const id of ids) ins.run(clientId, id);
}
route('POST', '/api/clients', true, async (req, res, body, me) => {
  if (me.role !== 'owner' && me.role !== 'partner') throw new HttpError(403, 'Only the owner and partners can add clients.');
  if (me.role === 'partner') body.managerId = me.id;
  if (!('name' in body)) throw bad('Enter the client name.');
  const f = clientFields(body, me, null);
  f.scope = body.scope === 'intl' ? 'intl' : 'local';
  const id = tx(() => {
    const now = Date.now(); const cols = Object.keys(f);
    const r = db.prepare(`INSERT INTO clients (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`).run(...cols.map(k => f[k]), now, now);
    const cid = Number(r.lastInsertRowid);
    if (f.scope === 'intl') setClientAccess(cid, body.accessIds || [], f.manager_id);
    else if (body.staffIds) setClientStaff(me, cid, f.manager_id, body.staffIds);
    return cid;
  });
  send(res, 201, { client: clientOut(getClient(id), me) });
});
route('PATCH', '/api/clients/:id', true, async (req, res, body, me, params) => {
  const c = getClient(params.id);
  if (!canSeeClient(me, c)) throw new HttpError(404, 'Client not found.');
  if (!canEditClient(me, c)) throw new HttpError(403, 'You can view this client but not change it.');
  const f = clientFields(body, me, c);
  tx(() => {
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE clients SET ${cols.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(k => f[k]), Date.now(), c.id);
    if (c.scope === 'intl') {
      if ('accessIds' in body || 'managerId' in f) {
        const cur = db.prepare('SELECT user_id FROM client_access WHERE client_id = ?').all(c.id).map(r => r.user_id);
        const mid = 'manager_id' in f ? f.manager_id : c.manager_id;
        const next = new Set([...(body.accessIds ?? cur).map(Number), ...(mid ? [mid] : [])]);
        // Nobody may lose access while they still have open work for this client
        for (const uid of cur.filter(id => !next.has(id))) {
          const open = db.prepare("SELECT COUNT(*) n FROM tasks WHERE client_id = ? AND assignee_id = ? AND status <> 'done'").get(c.id, uid).n
                     + db.prepare('SELECT COUNT(*) n FROM recurring WHERE client_id = ? AND assignee_id = ? AND active = 1').get(c.id, uid).n;
          if (open) throw bad(`${db.prepare('SELECT name FROM users WHERE id = ?').get(uid).name} still has ${open} open or recurring task${open === 1 ? '' : 's'} for this client. Reassign them first.`);
        }
        setClientAccess(c.id, [...next], mid);
      }
    } else if ('staffIds' in body) {
      // a partner editing keeps staff from other teams that the owner assigned
      let keep = [];
      if (me.role === 'partner') keep = db.prepare('SELECT cs.user_id FROM client_staff cs JOIN users u ON u.id = cs.user_id WHERE cs.client_id = ? AND u.manager_id <> ?').all(c.id, me.id).map(r => r.user_id);
      setClientStaff(me, c.id, f.manager_id ?? c.manager_id, body.staffIds);
      const ins = db.prepare('INSERT OR IGNORE INTO client_staff VALUES (?,?)'); for (const k of keep) ins.run(c.id, k);
    }
  });
  send(res, 200, { client: clientOut(getClient(c.id), me) });
});
// Local clients use the fixed Pakistani portals; international clients can name their own (HMRC, IRS, ...)
function portalName(c, raw) {
  let a; try { a = decodeURIComponent(String(raw)).trim(); } catch { throw bad('Unknown portal.'); }
  if (c.scope !== 'intl') { a = a.toUpperCase(); if (!AUTHORITIES.includes(a)) throw bad('Unknown portal.'); return a; }
  if (!/^[A-Za-z0-9 .&()'-]{1,40}$/.test(a)) throw bad('Portal name can use letters, numbers, spaces and . & ( ) - (up to 40 characters).');
  return a;
}
route('PUT', '/api/clients/:id/logins/:auth', true, async (req, res, body, me, params) => {
  const c = getClient(params.id);
  if (!canSeeClient(me, c)) throw new HttpError(404, 'Client not found.');
  if (!canEditClient(me, c)) throw new HttpError(403, 'You can view this client\'s logins but not change them.');
  const auth = portalName(c, params.auth);
  const loginId = str(body.loginId, 80, 'Login ID');
  const cur = db.prepare('SELECT * FROM client_logins WHERE client_id = ? AND authority = ?').get(c.id, auth);
  // null/undefined keeps the saved value; '' clears it
  const secret = body.password == null ? (cur?.secret_enc || '') : encrypt(str(body.password, 200, 'Password'));
  const pin = body.pin == null ? (cur?.pin_enc || '') : encrypt(str(body.pin, 50, 'PIN'));
  db.prepare(`INSERT INTO client_logins (client_id, authority, login_id, secret_enc, pin_enc, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(client_id, authority) DO UPDATE SET login_id=excluded.login_id, secret_enc=excluded.secret_enc, pin_enc=excluded.pin_enc, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(c.id, auth, loginId, secret, pin, Date.now(), me.id);
  send(res, 200, { client: clientOut(getClient(c.id), me) });
});
route('DELETE', '/api/clients/:id/logins/:auth', true, async (req, res, body, me, params) => {
  const c = getClient(params.id);
  if (!canSeeClient(me, c)) throw new HttpError(404, 'Client not found.');
  if (!canEditClient(me, c)) throw new HttpError(403, 'You can view this client\'s logins but not change them.');
  db.prepare('DELETE FROM client_logins WHERE client_id = ? AND authority = ?').run(c.id, portalName(c, params.auth));
  send(res, 200, { client: clientOut(getClient(c.id), me) });
});
route('POST', '/api/clients/:id/logins/:auth/reveal', true, async (req, res, body, me, params) => {
  const c = getClient(params.id);
  if (!canSeeClient(me, c)) throw new HttpError(404, 'Client not found.');
  const auth = portalName(c, params.auth);
  const l = db.prepare('SELECT * FROM client_logins WHERE client_id = ? AND authority = ?').get(c.id, auth);
  if (!l) throw new HttpError(404, 'No login saved for this portal.');
  const out = { loginId: l.login_id, password: decrypt(l.secret_enc), pin: decrypt(l.pin_enc) };
  db.prepare('INSERT INTO secret_views (client_id, authority, user_id, viewed_at) VALUES (?,?,?,?)').run(c.id, auth, me.id, Date.now());
  send(res, 200, out);
});
route('GET', '/api/clients/:id/access-log', true, async (req, res, body, me, params) => {
  const c = getClient(params.id);
  if (!canSeeClient(me, c) || !canEditClient(me, c)) throw new HttpError(404, 'Client not found.');
  const rows = db.prepare(`SELECT v.authority, v.viewed_at, u.name FROM secret_views v JOIN users u ON u.id = v.user_id
                           WHERE v.client_id = ? ORDER BY v.viewed_at DESC LIMIT 100`).all(c.id);
  send(res, 200, { log: rows.map(r => ({ authority: r.authority, at: r.viewed_at, name: r.name })) });
});

/* ---- tasks ---- */
route('GET', '/api/tasks', true, async (req, res, body, me) => {
  const pm = partnerMap(); const ctx = intlCtx(me);
  const rows = db.prepare(TASK_SELECT + ' ORDER BY t.created_at DESC').all().filter(t => visibleTask(me, t, pm.get(t.id) || [], ctx));
  send(res, 200, { tasks: rows.map(t => taskOut(t, me, pm.get(t.id) || [])) });
});
// Owner: anyone. Partner: any partner or staff member.
function checkAssignee(me, id) {
  const a = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND deleted = 0').get(Number(id));
  if (!a) throw bad('Choose who this task is for.');
  if (me.role === 'owner') return a;
  if (me.role === 'staff') { if (a.id === me.id) return a; throw bad('You can only add tasks for yourself.'); }
  if (me.role === 'partner') { if (a.role === 'owner') throw bad('Partners can assign to partners and staff.'); return a; }
  if (me.role === 'manager' && teamIds(me).includes(a.id)) return a;
  throw bad('You can only assign tasks to your own team.');
}
const canHavePersonal = me => ['owner', 'partner', 'manager'].includes(me.role);
// Client and category are compulsory on work assigned to someone else, and on anything staff add
const needsClientCat = (me, assigneeId, creatorId, visibility) => visibility === 'business' && (assigneeId !== creatorId || me.role === 'staff');
function requireClientCat(cat, cli) {
  if (cat == null) throw bad('Choose a task category.');
  if (cli == null) throw bad('Choose a client.');
}
const NEED_PARTNER = 'Business tasks you add for yourself need at least one partner who can follow them.';
function checkCategory(v) { const id = intOrNull(v); if (id === null) return null; if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw bad('Choose a valid category.'); return id; }
function checkClient(me, v) { const id = intOrNull(v); if (id === null) return null; const c = getClient(id); if (!canSeeClient(me, c) || !c.active) throw bad('Choose one of your clients.'); return id; }

route('POST', '/api/tasks', true, async (req, res, body, me) => {
  // Staff may add business tasks for themselves only; the owner and their partner see them.
  const title = str(body.title, 160, 'Task'); if (!title) throw bad('Enter a task title.');
  const notes = str(body.notes, 2000, 'Notes'); const due = str(body.due, 10, 'Due date');
  const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium';
  if (!isDate(due)) throw bad('Due date is not valid.');
  const visibility = body.visibility === 'personal' ? 'personal' : 'business';
  let a, partners;
  if (visibility === 'personal') {
    if (!canHavePersonal(me)) throw new HttpError(403, 'Personal tasks are not available for staff.');
    a = me; partners = []; // a personal task is always your own and nobody else sees it
  } else {
    a = checkAssignee(me, body.assigneeId);
    partners = checkPartners(body.partnerIds, null);
    if (me.role === 'manager' && a.id === me.id && !partners.length) throw bad(NEED_PARTNER);
  }
  const cat = checkCategory(body.categoryId); const cli = checkClient(me, body.clientId);
  if (needsClientCat(me, a.id, me.id, visibility)) requireClientCat(cat, cli);
  checkIntlPeople(cli, [a.id, ...partners]);
  checkWorkArea(cli, [a.id]);
  const now = Date.now();
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO tasks (title,notes,priority,due,assignee_id,created_by,created_at,updated_at,updated_by,category_id,client_id,visibility)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, notes, priority, due, a.id, me.id, now, now, me.id, cat, cli, visibility);
    setTaskPartners(Number(r.lastInsertRowid), partners);
    return Number(r.lastInsertRowid);
  });
  send(res, 201, { task: taskOut(db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(id), me) });
});
route('PATCH', '/api/tasks/:id', true, async (req, res, body, me, params) => {
  const t = db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(Number(params.id));
  if (!visibleTask(me, t)) throw new HttpError(404, 'Task not found.');
  const full = canEditTask(me, t); const sets = {};
  if ('status' in body) {
    if (!['todo', 'doing', 'done'].includes(body.status)) throw bad('Unknown status.');
    if (!full && t.assignee_id !== me.id) throw new HttpError(403, 'You can only update your own tasks.');
    sets.status = body.status; sets.done_at = body.status === 'done' ? Date.now() : null;
  }
  if ('progress' in body) {
    if (!full && t.assignee_id !== me.id) throw new HttpError(403, 'You can only update your own tasks.');
    sets.progress = str(body.progress, 1000, 'Progress note');
  }
  for (const f of ['title', 'notes', 'priority', 'due', 'assigneeId', 'categoryId', 'clientId']) {
    if (!(f in body)) continue;
    if (!full) throw new HttpError(403, 'You can update status and progress only.');
    if (f === 'title') { const v = str(body.title, 160, 'Task'); if (!v) throw bad('Enter a task title.'); sets.title = v; }
    if (f === 'notes') sets.notes = str(body.notes, 2000, 'Notes');
    if (f === 'priority') { if (!['high', 'medium', 'low'].includes(body.priority)) throw bad('Unknown priority.'); sets.priority = body.priority; }
    if (f === 'due') { const v = str(body.due, 10, 'Due date'); if (!isDate(v)) throw bad('Due date is not valid.'); sets.due = v; }
    if (f === 'assigneeId') sets.assignee_id = checkAssignee(me, body.assigneeId).id;
    if (f === 'categoryId') sets.category_id = checkCategory(body.categoryId);
    if (f === 'clientId') sets.client_id = (intOrNull(body.clientId) === t.client_id) ? t.client_id : checkClient(me, body.clientId);
  }
  if ('visibility' in body) {
    if (!['business', 'personal'].includes(body.visibility)) throw bad('Choose Business or Personal.');
    if (body.visibility !== t.visibility && t.created_by !== me.id) throw new HttpError(403, 'Only the person who added this task can change Business or Personal.');
    if (body.visibility === 'personal' && !canHavePersonal(me)) throw new HttpError(403, 'Personal tasks are not available for staff.');
    sets.visibility = body.visibility;
  }
  if ('partnerIds' in body && !full) throw new HttpError(403, 'You can update status and progress only.');
  if (('categoryId' in body || 'clientId' in body || 'assigneeId' in body) &&
      needsClientCat(me, sets.assignee_id ?? t.assignee_id, t.created_by, sets.visibility ?? t.visibility))
    requireClientCat('category_id' in sets ? sets.category_id : t.category_id, 'client_id' in sets ? sets.client_id : t.client_id);
  const vis = sets.visibility ?? t.visibility, assignee = sets.assignee_id ?? t.assignee_id;
  let partners = 'partnerIds' in body ? checkPartners(body.partnerIds, null) : taskPartners(t.id).map(p => p.id);
  if (vis === 'personal') {
    if (assignee !== t.created_by) throw bad('A personal task can only be for the person who added it.');
    partners = [];
  } else if (me.role === 'manager' && t.created_by === me.id && assignee === me.id && !partners.length &&
             ('partnerIds' in body || 'visibility' in body || 'assigneeId' in body)) throw bad(NEED_PARTNER);
  if ('clientId' in body || 'assigneeId' in body || 'partnerIds' in body)
    checkIntlPeople('client_id' in sets ? sets.client_id : t.client_id, [assignee, ...(vis === 'personal' ? [] : partners)]);
  if ('clientId' in body || 'assigneeId' in body) checkWorkArea('client_id' in sets ? sets.client_id : t.client_id, [assignee]);
  const keys = Object.keys(sets);
  tx(() => {
    if (keys.length) {
      sets.updated_at = Date.now(); sets.updated_by = me.id; keys.push('updated_at', 'updated_by');
      db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), t.id);
    }
    if (me.role === 'partner' && t.assignee_id === me.id && assignee !== me.id && vis === 'business' && !partners.includes(me.id)) partners.push(me.id);
    if ('partnerIds' in body || vis === 'personal' || assignee !== t.assignee_id) setTaskPartners(t.id, partners);
  });
  send(res, 200, { task: taskOut(db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(t.id), me) });
});
route('DELETE', '/api/tasks/:id', true, async (req, res, body, me, params) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id));
  if (!visibleTask(me, t)) throw new HttpError(404, 'Task not found.');
  if (!canDeleteTask(me, t)) throw new HttpError(403, 'You cannot delete this task. Ask the person who assigned it or the owner.');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  send(res, 200, { ok: true });
});

/* ---- recurring tasks ---- */
// Every due date for a rule from `fromYmd` (exclusive) to `toYmd` (inclusive)
function dueDates(r, fromYmd, toYmd) {
  const out = []; const months = r.months ? r.months.split(',').map(Number) : [];
  let y = Number(fromYmd.slice(0, 4)), m = Number(fromYmd.slice(5, 7));
  const endY = Number(toYmd.slice(0, 4)), endM = Number(toYmd.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const hit = r.frequency === 'monthly' || (r.frequency === 'quarterly' && months.includes(m)) || (r.frequency === 'annual' && m === r.due_month);
    if (hit) {
      const due = `${y}-${pad(m)}-${pad(Math.min(r.due_day, dim(y, m)))}`;
      if (due > fromYmd && due <= toYmd) out.push({ due, ...periodLabel(r, y, m) });
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
// The period a return covers: the month or quarter before the due date; tax year for annual
function periodLabel(r, y, m) {
  if (r.frequency === 'monthly') { let py = y, pm = m - 1; if (pm < 1) { pm = 12; py--; } return { period: `${py}-${pad(pm)}`, label: `${MON[pm - 1]} ${py}` }; }
  if (r.frequency === 'quarterly') {
    let ey = y, em = m - 1; if (em < 1) { em = 12; ey--; }
    let sy = ey, sm = em - 2; if (sm < 1) { sm += 12; sy--; }
    return { period: `${ey}-Q${pad(em)}`, label: `${MON[sm - 1]}–${MON[em - 1]} ${ey}` };
  }
  const ty = m >= 7 ? y : y - 1;
  return { period: `TY${ty}`, label: `Tax Year ${ty}` };
}
function generateRecurring(onlyId) {
  const today = localToday(); let made = 0;
  const rules = onlyId ? db.prepare('SELECT * FROM recurring WHERE id = ? AND active = 1').all(onlyId) : db.prepare('SELECT * FROM recurring WHERE active = 1').all();
  for (const r of rules) {
    const assignee = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(r.assignee_id);
    if (!assignee) continue;
    const client = r.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id) : null;
    if (client && !client.active) continue;
    const from = r.last_due || addDays(today, -1);
    const list = dueDates(r, from, addDays(today, r.lead_days));
    if (!list.length) continue;
    tx(() => {
      for (const d of list) {
        const title = [r.title, client?.name, d.label].filter(Boolean).join(' — ');
        const now = Date.now();
        const ins = db.prepare(`INSERT INTO tasks (title,notes,priority,due,assignee_id,created_by,created_at,updated_at,updated_by,category_id,client_id,recurring_id,period)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, r.notes, r.priority, d.due, r.assignee_id, r.created_by, now, now, r.created_by, r.category_id, r.client_id, r.id, d.period);
        const pids = (r.partner_ids || '').split(',').filter(Boolean).map(Number)
          .filter(id => db.prepare("SELECT 1 FROM users WHERE id = ? AND role IN ('partner','owner') AND active = 1 AND deleted = 0").get(id));
        setTaskPartners(Number(ins.lastInsertRowid), pids);
        made++;
      }
      db.prepare('UPDATE recurring SET last_due = ? WHERE id = ?').run(list[list.length - 1].due, r.id);
    });
  }
  return made;
}
function nextDue(r) { const t = localToday(); const n = dueDates(r, r.last_due && r.last_due > t ? r.last_due : addDays(t, -1), addDays(t, 400)); return n[0]?.due || ''; }
function ruleOut(r, me) {
  return {
    id: r.id, title: r.title, categoryId: r.category_id, categoryName: r.category_name || '', clientId: r.client_id, clientName: r.client_name || '',
    assigneeId: r.assignee_id, assigneeName: r.assignee_name, frequency: r.frequency, dueDay: r.due_day, dueMonth: r.due_month,
    months: r.months ? r.months.split(',').map(Number) : [], leadDays: r.lead_days, priority: r.priority, notes: r.notes, active: !!r.active,
    lastDue: r.last_due, nextDue: r.active ? nextDue(r) : '', createdBy: r.created_by, canEdit: canEditRule(me, r),
    partnerIds: (r.partner_ids || '').split(',').filter(Boolean).map(Number),
  };
}
const RULE_SELECT = `SELECT r.*, k.name category_name, c.name client_name, a.name assignee_name FROM recurring r
  LEFT JOIN categories k ON k.id = r.category_id LEFT JOIN clients c ON c.id = r.client_id JOIN users a ON a.id = r.assignee_id`;
function canSeeRule(me, r) {
  if (intlHidden(me, r.client_id)) return false;
  if (me.role === 'owner') return true;
  if (r.created_by === me.id || r.assignee_id === me.id) return true;
  if (me.role === 'partner') return teamIds(me).includes(r.assignee_id) || (r.partner_ids || '').split(',').map(Number).includes(me.id);
  return false;
}
function canEditRule(me, r) {
  if (me.role === 'owner' || (me.role !== 'staff' && r.created_by === me.id)) return true;
  return me.role === 'partner' && r.assignee_id !== me.id && teamIds(me).includes(r.assignee_id);
}
function ruleFields(body, me, cur) {
  const f = {};
  if ('title' in body) { f.title = str(body.title, 120, 'Task name'); if (!f.title) throw bad('Enter the task name.'); }
  if ('categoryId' in body) f.category_id = checkCategory(body.categoryId);
  if ('clientId' in body) f.client_id = (cur && intOrNull(body.clientId) === cur.client_id) ? cur.client_id : checkClient(me, body.clientId);
  if ('assigneeId' in body) f.assignee_id = checkAssignee(me, body.assigneeId).id;
  if ('frequency' in body) { if (!['monthly', 'quarterly', 'annual'].includes(body.frequency)) throw bad('Choose how often it repeats.'); f.frequency = body.frequency; }
  if ('dueDay' in body) { const d = Number(body.dueDay); if (!Number.isInteger(d) || d < 1 || d > 31) throw bad('Due day must be between 1 and 31.'); f.due_day = d; }
  if ('dueMonth' in body) { const d = intOrNull(body.dueMonth); if (d !== null && (!Number.isInteger(d) || d < 1 || d > 12)) throw bad('Choose the due month.'); f.due_month = d; }
  if ('months' in body) {
    if (!Array.isArray(body.months)) throw bad('Choose the months.');
    const ms = [...new Set(body.months.map(Number))].filter(x => x >= 1 && x <= 12).sort((a, b) => a - b); f.months = ms.join(',');
  }
  if ('leadDays' in body) { const d = Number(body.leadDays); if (!Number.isInteger(d) || d < 0 || d > 60) throw bad('Create-ahead days must be between 0 and 60.'); f.lead_days = d; }
  if ('priority' in body) { if (!['high', 'medium', 'low'].includes(body.priority)) throw bad('Unknown priority.'); f.priority = body.priority; }
  if ('notes' in body) f.notes = str(body.notes, 2000, 'Instructions');
  if ('active' in body) f.active = body.active ? 1 : 0;
  if ('partnerIds' in body) f.partner_ids = checkPartners(body.partnerIds, null).join(',');
  if ('clientId' in body || 'assigneeId' in body || 'partnerIds' in body)
    checkIntlPeople('client_id' in f ? f.client_id : cur?.client_id,
      [f.assignee_id ?? cur?.assignee_id, ...(('partner_ids' in f ? f.partner_ids : cur?.partner_ids || '').split(',').filter(Boolean).map(Number))]);
  if ('clientId' in body || 'assigneeId' in body) checkWorkArea('client_id' in f ? f.client_id : cur?.client_id, [f.assignee_id ?? cur?.assignee_id]);
  const freq = f.frequency ?? cur?.frequency;
  if (freq === 'annual' && !(f.due_month ?? cur?.due_month)) throw bad('Choose the month the yearly task is due.');
  if (freq === 'quarterly' && !(f.months ?? cur?.months)) throw bad('Choose the months the quarterly task is due.');
  return f;
}
route('GET', '/api/recurring', true, async (req, res, body, me) => {
  if (me.role === 'staff') return send(res, 200, { rules: [] });
  const rows = db.prepare(RULE_SELECT + ' ORDER BY r.title').all().filter(r => canSeeRule(me, r));
  send(res, 200, { rules: rows.map(r => ruleOut(r, me)) });
});
route('POST', '/api/recurring', true, async (req, res, body, me) => {
  if (me.role === 'staff') throw new HttpError(403, 'Staff cannot set up recurring tasks.');
  for (const k of ['title', 'assigneeId', 'frequency', 'dueDay']) if (!(k in body)) throw bad('Fill in the task name, person, frequency and due day.');
  const f = ruleFields(body, me, null);
  const cols = Object.keys(f);
  const r = db.prepare(`INSERT INTO recurring (${cols.join(',')}, created_by, created_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`).run(...cols.map(k => f[k]), me.id, Date.now());
  const id = Number(r.lastInsertRowid);
  const made = generateRecurring(id);
  send(res, 201, { rule: ruleOut(db.prepare(RULE_SELECT + ' WHERE r.id = ?').get(id), me), created: made });
});
route('PATCH', '/api/recurring/:id', true, async (req, res, body, me, params) => {
  const cur = db.prepare(RULE_SELECT + ' WHERE r.id = ?').get(Number(params.id));
  if (!cur || !canSeeRule(me, cur)) throw new HttpError(404, 'Recurring task not found.');
  if (!canEditRule(me, cur)) throw new HttpError(403, 'You cannot change this recurring task.');
  const f = ruleFields(body, me, cur); const cols = Object.keys(f);
  // Schedule changes start fresh from today so no past deadlines are back-filled
  const sched = ['frequency', 'due_day', 'due_month', 'months'].some(k => k in f && String(f[k]) !== String(cur[k]));
  if (sched || (f.active === 1 && !cur.active)) { f.last_due = cur.last_due > localToday() ? cur.last_due : ''; cols.push('last_due'); }
  if (cols.length) db.prepare(`UPDATE recurring SET ${cols.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map(k => f[k]), cur.id);
  const made = generateRecurring(cur.id);
  send(res, 200, { rule: ruleOut(db.prepare(RULE_SELECT + ' WHERE r.id = ?').get(cur.id), me), created: made });
});
route('DELETE', '/api/recurring/:id', true, async (req, res, body, me, params) => {
  const cur = db.prepare('SELECT * FROM recurring WHERE id = ?').get(Number(params.id));
  if (!cur || !canSeeRule(me, cur)) throw new HttpError(404, 'Recurring task not found.');
  if (!canEditRule(me, cur)) throw new HttpError(403, 'You cannot delete this recurring task.');
  db.prepare('UPDATE tasks SET recurring_id = NULL WHERE recurring_id = ?').run(cur.id);
  db.prepare('DELETE FROM recurring WHERE id = ?').run(cur.id);
  send(res, 200, { ok: true });
});

/* -------------------------------------------------------- static files */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p; try { p = decodeURIComponent(urlPath); } catch { res.writeHead(400); return res.end(); }
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(path.extname(file)) ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}

/* --------------------------------------------------------------- server */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  try {
    if (req.method !== 'GET' && req.headers['x-cbg'] !== '1') throw new HttpError(403, 'Request blocked.');
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found.');
    const params = url.pathname.match(r.re).groups || {};
    let me = null;
    if (r.auth) {
      me = sessionUser(req);
      if (!me) throw new HttpError(401, 'Please sign in.');
      if (me.must_change && url.pathname !== '/api/me/password' && url.pathname !== '/api/me') throw new HttpError(403, 'Choose a new password first.');
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    await r.fn(req, res, body, me, params);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500 && !(e instanceof HttpError)) console.error(e);
    send(res, status, { error: status === 500 && !(e instanceof HttpError) ? 'Something went wrong on the server.' : e.message });
  }
});

generateRecurring();
setInterval(() => { try { generateRecurring(); } catch (e) { console.error('Recurring task generator:', e); } }, 3600e3).unref();
server.listen(PORT, () => console.log(`Corporate Brilliance Global — Clients and Employee Tasks Management running on http://localhost:${PORT}`));
