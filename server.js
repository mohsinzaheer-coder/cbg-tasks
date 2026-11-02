'use strict';
/*
 * Corporate Brilliance Global — Employee Task Management
 * Zero-dependency Node.js server (Node 22.13+): node:http, node:sqlite, node:crypto.
 *
 * Roles
 *   owner   — sees and manages everyone and every task
 *   manager — sees himself and his own staff; assigns tasks to them
 *   staff   — sees only tasks assigned to him; can update status and progress note
 * Every rule below is enforced here on the server, never only in the browser.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cbg.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
const COOKIE = 'cbg_sid';

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
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','staff')),
  manager_id    INTEGER REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
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
`);

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
  const test = crypto.scryptSync(pw, Buffer.from(s, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
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
  const { n } = db.prepare('SELECT COUNT(*) n FROM users').get();
  if (n > 0) return;
  const username = (process.env.OWNER_USERNAME || 'owner').trim();
  let password = process.env.OWNER_PASSWORD;
  let generated = false;
  if (!password || passwordProblem(password)) { password = 'Cbg-' + crypto.randomBytes(6).toString('base64url') + '7'; generated = true; }
  db.prepare(`INSERT INTO users (username,password_hash,name,title,role,must_change,created_at)
              VALUES (?,?,?,?, 'owner', 1, ?)`)
    .run(username, hashPassword(password), process.env.OWNER_NAME || 'Owner', 'Owner', Date.now());
  console.log('\n=== Owner account created ===');
  console.log('Login ID :', username);
  console.log('Password :', generated ? password : '(the OWNER_PASSWORD you set)');
  console.log('You will be asked to choose a new password at first sign-in.\n');
})();

/* ------------------------------------------------------------- sessions */
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ?`).get(sha(token));
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return row;
}
function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}
function setCookie(res, req, token, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (isHttps(req) ? '; Secure' : ''));
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

/* ---------------------------------------------------- login rate limits */
const attempts = new Map(); // key -> {count, until}
function limited(key) { const a = attempts.get(key); return a && a.count >= 5 && a.until > Date.now(); }
function fail(key) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 15 * 60e3 });
  else a.count++;
}

/* ---------------------------------------------------------- permissions */
const publicUser = u => u && ({
  id: u.id, username: u.username, name: u.name, title: u.title, role: u.role,
  managerId: u.manager_id, active: !!u.active, mustChange: !!u.must_change,
});
// Ids of people whose tasks this user may see and assign to
function teamIds(me) {
  if (me.role === 'owner') return null; // everyone
  if (me.role === 'manager') {
    return [me.id, ...db.prepare("SELECT id FROM users WHERE manager_id = ? AND role = 'staff'").all(me.id).map(r => r.id)];
  }
  return [me.id];
}
function canManageUser(me, target) {
  if (!target) return false;
  if (me.role === 'owner') return true;
  if (me.role === 'manager') return target.role === 'staff' && target.manager_id === me.id;
  return false;
}
function visibleTask(me, t) {
  if (!t) return false;
  if (me.role === 'owner') return true;
  if (me.role === 'manager') return teamIds(me).includes(t.assignee_id) || t.created_by === me.id;
  return t.assignee_id === me.id;
}
// Full edit/delete: owner always; manager for tasks on his staff or that he created (not ones assigned to him from above)
function canEditTask(me, t) {
  if (me.role === 'owner') return true;
  if (me.role === 'manager') return t.created_by === me.id || (t.assignee_id !== me.id && teamIds(me).includes(t.assignee_id));
  return false;
}
function taskOut(t, me) {
  return {
    id: t.id, title: t.title, notes: t.notes, priority: t.priority, due: t.due, status: t.status,
    progress: t.progress, assigneeId: t.assignee_id, assigneeName: t.assignee_name, createdBy: t.created_by,
    createdByName: t.creator_name, createdAt: t.created_at, updatedAt: t.updated_at, doneAt: t.done_at,
    canEdit: canEditTask(me, t),
  };
}
const TASK_SELECT = `SELECT t.*, a.name assignee_name, c.name creator_name FROM tasks t
  JOIN users a ON a.id = t.assignee_id JOIN users c ON c.id = t.created_by`;

/* ------------------------------------------------------------- helpers */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);
const str = (v, max, field) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  v = v.trim();
  if (v.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return v;
};
const isDate = v => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
      catch { reject(bad('Invalid request body.')); }
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- routes */
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), auth, fn });

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
  setCookie(res, req, '', 0);
  send(res, 200, { ok: true });
});

route('GET', '/api/me', true, async (req, res, body, me) => send(res, 200, { user: publicUser(me) }));

route('POST', '/api/me/password', true, async (req, res, body, me) => {
  if (!verifyPassword(String(body.current || ''), me.password_hash)) throw bad('Current password is incorrect.');
  const p = passwordProblem(body.next); if (p) throw bad(p);
  if (body.next === body.current) throw bad('Choose a password different from the current one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(body.next), me.id);
  const keep = sha(parseCookies(req)[COOKIE]);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(me.id, keep); // sign out other devices
  send(res, 200, { ok: true });
});

route('GET', '/api/users', true, async (req, res, body, me) => {
  let rows;
  if (me.role === 'owner') rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  else if (me.role === 'manager') rows = db.prepare("SELECT * FROM users WHERE id = ? OR (manager_id = ? AND role = 'staff') ORDER BY name").all(me.id, me.id);
  else rows = [me];
  send(res, 200, { users: rows.map(publicUser) });
});

route('POST', '/api/users', true, async (req, res, body, me) => {
  if (me.role === 'staff') throw new HttpError(403, 'Staff cannot add people.');
  const name = str(body.name, 80, 'Name'); const username = str(body.username, 40, 'Login ID');
  const title = str(body.title, 60, 'Job title');
  const role = me.role === 'owner' ? body.role : 'staff';
  if (!name) throw bad('Enter a name.');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw bad('Login ID must be 3–40 letters, numbers, dots, dashes or underscores.');
  if (!['manager', 'staff'].includes(role)) throw bad('Role must be manager or staff.');
  const p = passwordProblem(body.password); if (p) throw bad(p);
  let managerId = null;
  if (role === 'staff') {
    managerId = me.role === 'manager' ? me.id : Number(body.managerId);
    const m = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'manager' AND active = 1").get(managerId);
    if (!m) throw bad('Choose the manager this staff member reports to.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That login ID is already taken.');
  const r = db.prepare(`INSERT INTO users (username,password_hash,name,title,role,manager_id,must_change,created_at)
                        VALUES (?,?,?,?,?,?,1,?)`).run(username, hashPassword(body.password), name, title, role, managerId, Date.now());
  send(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
});

route('PATCH', '/api/users/:id', true, async (req, res, body, me, params) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!canManageUser(me, target) || (target.id === me.id && me.role !== 'owner')) throw new HttpError(404, 'Person not found.');
  const sets = {};
  if ('name' in body) { const n = str(body.name, 80, 'Name'); if (!n) throw bad('Enter a name.'); sets.name = n; }
  if ('title' in body) sets.title = str(body.title, 60, 'Job title');
  if ('password' in body) { const p = passwordProblem(body.password); if (p) throw bad(p); sets.password_hash = hashPassword(body.password); sets.must_change = 1; }
  if ('active' in body) {
    if (target.id === me.id) throw bad('You cannot deactivate your own account.');
    if (target.role === 'manager' && !body.active &&
        db.prepare("SELECT 1 FROM users WHERE manager_id = ? AND active = 1").get(target.id)) throw bad('Move this manager\'s staff to another manager first.');
    sets.active = body.active ? 1 : 0;
  }
  if ('managerId' in body) {
    if (me.role !== 'owner' || target.role !== 'staff') throw new HttpError(403, 'Only the owner can move staff between managers.');
    const m = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'manager' AND active = 1").get(Number(body.managerId));
    if (!m) throw bad('Choose an active manager.');
    sets.manager_id = m.id;
  }
  const keys = Object.keys(sets);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), target.id);
  if ('password' in body || sets.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  send(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});

route('GET', '/api/tasks', true, async (req, res, body, me) => {
  let rows;
  if (me.role === 'owner') rows = db.prepare(TASK_SELECT + ' ORDER BY t.created_at DESC').all();
  else {
    const ids = teamIds(me);
    rows = db.prepare(`${TASK_SELECT} WHERE t.assignee_id IN (${ids.map(() => '?').join(',')})` +
      (me.role === 'manager' ? ' OR t.created_by = ?' : '') + ' ORDER BY t.created_at DESC')
      .all(...ids, ...(me.role === 'manager' ? [me.id] : []));
  }
  send(res, 200, { tasks: rows.map(t => taskOut(t, me)) });
});

function checkAssignee(me, id) {
  const a = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(id));
  const team = teamIds(me);
  if (!a || (team && !team.includes(a.id))) throw bad('You can only assign tasks to your own team.');
  return a;
}

route('POST', '/api/tasks', true, async (req, res, body, me) => {
  if (me.role === 'staff') throw new HttpError(403, 'Staff cannot create tasks.');
  const title = str(body.title, 160, 'Task'); if (!title) throw bad('Enter a task title.');
  const notes = str(body.notes, 2000, 'Notes'); const due = str(body.due, 10, 'Due date');
  const priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium';
  if (!isDate(due)) throw bad('Due date is not valid.');
  const a = checkAssignee(me, body.assigneeId);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO tasks (title,notes,priority,due,assignee_id,created_by,created_at,updated_at,updated_by)
                        VALUES (?,?,?,?,?,?,?,?,?)`).run(title, notes, priority, due, a.id, me.id, now, now, me.id);
  send(res, 201, { task: taskOut(db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(r.lastInsertRowid), me) });
});

route('PATCH', '/api/tasks/:id', true, async (req, res, body, me, params) => {
  const t = db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(Number(params.id));
  if (!visibleTask(me, t)) throw new HttpError(404, 'Task not found.');
  const full = canEditTask(me, t);
  const sets = {};
  // Anyone who can see a task assigned to them can update its status and progress note
  if ('status' in body) {
    if (!['todo', 'doing', 'done'].includes(body.status)) throw bad('Unknown status.');
    if (!full && t.assignee_id !== me.id) throw new HttpError(403, 'You can only update your own tasks.');
    sets.status = body.status; sets.done_at = body.status === 'done' ? Date.now() : null;
  }
  if ('progress' in body) {
    if (!full && t.assignee_id !== me.id) throw new HttpError(403, 'You can only update your own tasks.');
    sets.progress = str(body.progress, 1000, 'Progress note');
  }
  for (const f of ['title', 'notes', 'priority', 'due', 'assigneeId']) {
    if (!(f in body)) continue;
    if (!full) throw new HttpError(403, 'You can update status and progress only.');
    if (f === 'title') { const v = str(body.title, 160, 'Task'); if (!v) throw bad('Enter a task title.'); sets.title = v; }
    if (f === 'notes') sets.notes = str(body.notes, 2000, 'Notes');
    if (f === 'priority') { if (!['high', 'medium', 'low'].includes(body.priority)) throw bad('Unknown priority.'); sets.priority = body.priority; }
    if (f === 'due') { const v = str(body.due, 10, 'Due date'); if (!isDate(v)) throw bad('Due date is not valid.'); sets.due = v; }
    if (f === 'assigneeId') sets.assignee_id = checkAssignee(me, body.assigneeId).id;
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    sets.updated_at = Date.now(); sets.updated_by = me.id; keys.push('updated_at', 'updated_by');
    db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), t.id);
  }
  send(res, 200, { task: taskOut(db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(t.id), me) });
});

route('DELETE', '/api/tasks/:id', true, async (req, res, body, me, params) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id));
  if (!visibleTask(me, t)) throw new HttpError(404, 'Task not found.');
  if (!canEditTask(me, t)) throw new HttpError(403, 'You cannot delete this task.');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  send(res, 200, { ok: true });
});

/* -------------------------------------------------------- static files */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

/* --------------------------------------------------------------- server */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
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
    // CSRF guard: state-changing calls must come from our own page (custom header + JSON)
    if (req.method !== 'GET' && req.headers['x-cbg'] !== '1') throw new HttpError(403, 'Request blocked.');
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found.');
    const params = url.pathname.match(r.re).groups || {};
    let me = null;
    if (r.auth) {
      me = sessionUser(req);
      if (!me) throw new HttpError(401, 'Please sign in.');
      const passwordRoute = url.pathname === '/api/me/password' || url.pathname === '/api/me';
      if (me.must_change && !passwordRoute) throw new HttpError(403, 'Choose a new password first.');
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    await r.fn(req, res, body, me, params);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
  }
});

server.listen(PORT, () => console.log(`Corporate Brilliance Global tasks running on http://localhost:${PORT}`));
