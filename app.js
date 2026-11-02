'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const STATUS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
  const PRI = { high: 0, medium: 1, low: 2 };
  const ROLE = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };
  const state = { me: null, users: [], tasks: [], tab: 'tasks', confirm: null, editing: null };

  /* ---------- utilities ---------- */
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls, fn) { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }
  const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const isLate = t => t.status !== 'done' && t.due && t.due < today();
  const userById = id => state.users.find(u => u.id === id);
  let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
  function showErr(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }
  function tempPassword() { const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'; const a = new Uint32Array(7); crypto.getRandomValues(a); return 'Cbg-' + [...a].map(n => c[n % c.length]).join('') + (a[0] % 90 + 10); }

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CBG': '1' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await res.json(); } catch { }
    if (res.status === 401 && url !== '/api/login') { state.me = null; show('login'); }
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
    return data;
  }

  /* ---------- views ---------- */
  function show(view) {
    $('#loginView').hidden = view !== 'login';
    $('#pwView').hidden = view !== 'password';
    $('#appView').hidden = view !== 'app';
  }

  async function boot() {
    try { const { user } = await api('GET', '/api/me'); state.me = user; }
    catch { show('login'); return; }
    if (state.me.mustChange) return openPassword(true);
    enterApp();
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#loginError');
    const b = e.submitter; b.disabled = true;
    try {
      const { user } = await api('POST', '/api/login', { username: $('#lUser').value.trim(), password: $('#lPass').value });
      state.me = user; $('#loginForm').reset();
      if (user.mustChange) openPassword(true); else enterApp();
    } catch (err) { showErr('#loginError', err.message); }
    finally { b.disabled = false; }
  });

  function openPassword(forced) {
    $('#pwForm').reset(); showErr('#pwError');
    $('#pwTitle').textContent = forced ? 'Choose your password' : 'Change password';
    $('#pwHelp').hidden = !forced; $('#pwCancel').hidden = forced;
    show('password'); $('#pCur').focus();
  }
  $('#pwCancel').onclick = () => show('app');
  $('#changePw').onclick = () => openPassword(false);
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#pwError');
    if ($('#pNew').value !== $('#pNew2').value) return showErr('#pwError', 'The two new passwords don\'t match.');
    const b = e.submitter; b.disabled = true;
    try {
      await api('POST', '/api/me/password', { current: $('#pCur').value, next: $('#pNew').value });
      state.me.mustChange = false; toast('Password saved'); enterApp();
    } catch (err) { showErr('#pwError', err.message); }
    finally { b.disabled = false; }
  });

  $('#logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch { } state.me = null; show('login'); $('#lUser').focus(); };

  async function enterApp() {
    show('app');
    const me = state.me;
    $('#meName').textContent = me.name; $('#meRole').textContent = ROLE[me.role] + (me.title && me.title !== ROLE[me.role] ? ' · ' + me.title : '');
    $('#tabs').hidden = me.role === 'staff';
    $('#newTaskBtn').hidden = me.role === 'staff';
    $('#fPersonWrap').hidden = me.role === 'staff';
    $('#tasksTitle').textContent = me.role === 'staff' ? 'My tasks' : me.role === 'manager' ? 'My team\'s tasks' : 'All tasks';
    $('#tasksSub').textContent = me.role === 'staff' ? 'Tasks assigned to you. Update the status as you go.' :
      me.role === 'manager' ? 'Tasks for you and the staff who report to you.' : 'Every task across all managers and staff.';
    $('#peopleSub').textContent = me.role === 'owner' ? 'Managers and the staff who report to each of them.' : 'The staff who report to you.';
    $('#newPersonBtn').textContent = me.role === 'owner' ? '+ Add person' : '+ Add staff member';
    setTab(state.tab === 'people' && me.role !== 'staff' ? 'people' : 'tasks');
    await refresh();
  }

  async function refresh() {
    try {
      const [u, t] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/tasks')]);
      state.users = u.users; state.tasks = t.tasks; render();
    } catch (err) { if (err.status !== 401) toast(err.message); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me && !$('#appView').hidden) refresh(); });
  setInterval(() => { if (state.me && !document.hidden && !$('#appView').hidden && !document.querySelector('dialog[open]')) refresh(); }, 60000);

  function setTab(t) {
    state.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $('#tasksPage').hidden = t !== 'tasks'; $('#peoplePage').hidden = t !== 'people';
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { setTab(b.dataset.tab); render(); } });

  function render() { renderPersonFilter(); renderTasks(); if (state.me.role !== 'staff') renderPeople(); }

  /* ---------- tasks ---------- */
  function renderPersonFilter() {
    const sel = $('#fPerson'); const keep = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    const active = state.users.filter(u => u.active);
    if (state.me.role === 'owner') {
      for (const m of active.filter(u => u.role === 'manager')) {
        const g = el('optgroup'); g.label = m.name + '’s team';
        const o = el('option', null, 'Whole team of ' + m.name); o.value = 'team:' + m.id; g.append(o);
        const om = el('option', null, m.name + ' (manager)'); om.value = String(m.id); g.append(om);
        for (const s of active.filter(u => u.managerId === m.id)) { const os = el('option', null, s.name); os.value = String(s.id); g.append(os); }
        sel.append(g);
      }
    } else {
      for (const u of active) { const o = el('option', null, u.id === state.me.id ? u.name + ' (me)' : u.name); o.value = String(u.id); sel.append(o); }
    }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  }

  function filteredTasks() {
    const p = $('#fPerson').value, pri = $('#fPri').value, q = $('#fText').value.trim().toLowerCase();
    return state.tasks.filter(t => {
      if (p.startsWith('team:')) { const mid = Number(p.slice(5)); const u = userById(t.assigneeId); if (!(t.assigneeId === mid || (u && u.managerId === mid))) return false; }
      else if (p && t.assigneeId !== Number(p)) return false;
      if (pri && t.priority !== pri) return false;
      if (q && !`${t.title} ${t.notes} ${t.progress} ${t.assigneeName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderTasks() {
    const tasks = filteredTasks();
    $('#sOpen').textContent = tasks.filter(t => t.status !== 'done').length;
    $('#sDoing').textContent = tasks.filter(t => t.status === 'doing').length;
    $('#sLate').textContent = tasks.filter(isLate).length;
    $('#sDone').textContent = tasks.filter(t => t.status === 'done').length;
    const host = $('#lanes'); host.replaceChildren();
    for (const [key, label] of STATUS) {
      const lane = el('section', 'lane'); lane.dataset.s = key;
      const list = tasks.filter(t => t.status === key).sort(key === 'done'
        ? (a, b) => (b.doneAt || 0) - (a.doneAt || 0)
        : (a, b) => (isLate(b) - isLate(a)) || (PRI[a.priority] - PRI[b.priority]) || (a.due || '9999').localeCompare(b.due || '9999'));
      const h = el('div', 'lane-h'); h.append(el('h3', null, label), el('span', null, String(list.length))); lane.append(h);
      if (!list.length) {
        const none = !state.tasks.length;
        lane.append(el('div', 'lane-empty', key === 'todo' && none
          ? (state.me.role === 'staff' ? 'No tasks assigned to you yet.' : 'No tasks yet. Use “Assign task” to give someone work.')
          : 'Nothing here'));
      }
      for (const t of list) lane.append(card(t));
      host.append(lane);
    }
  }

  function card(t) {
    const me = state.me; const mine = t.assigneeId === me.id;
    const c = el('article', 'card' + (isLate(t) ? ' overdue' : ''));
    c.append(el('p', 'card-t', t.title));
    if (t.notes) c.append(el('p', 'card-n', t.notes));
    if (t.progress) { const p = el('p', 'progress'); p.append(el('b', null, 'Progress'), document.createTextNode(t.progress)); c.append(p); }
    const m = el('div', 'meta');
    m.append(el('span', 'pill p-' + t.priority, t.priority));
    if (me.role !== 'staff' || !mine) { const w = el('span', 'who'); w.append(el('span', 'av', initials(t.assigneeName)), document.createTextNode(mine ? 'Me' : t.assigneeName)); m.append(w); }
    if (t.due) m.append(el('span', isLate(t) ? 'late' : '', (isLate(t) ? 'Overdue · ' : 'Due ') + fmtDate(t.due)));
    if (t.createdBy !== me.id) m.append(el('span', null, 'From ' + t.createdByName));
    c.append(m);

    const canStatus = mine || t.canEdit;
    if (!canStatus) return c;
    const a = el('div', 'actions'); const key = 'task:' + t.id;
    if (state.confirm === key) {
      const cf = el('div', 'confirm'); cf.append(el('span', null, 'Delete this task?'),
        btn('Delete', 'ghost danger', () => delTask(t)), btn('Keep', 'ghost', () => { state.confirm = null; renderTasks(); }));
      a.append(cf); c.append(a); return c;
    }
    for (const [k] of STATUS) if (k !== t.status) a.append(btn(k === 'done' ? 'Mark done' : k === 'doing' ? 'Start' : 'Back to To do', 'ghost', () => patchTask(t, { status: k })));
    a.append(btn(t.progress ? 'Edit note' : 'Add note', 'ghost', () => openNote(t)));
    if (t.canEdit) { a.append(btn('Edit', 'ghost', () => openTask(t)), btn('Delete', 'ghost danger', () => { state.confirm = key; renderTasks(); })); }
    c.append(a); return c;
  }

  async function patchTask(t, patch, msg) {
    try {
      const { task } = await api('PATCH', '/api/tasks/' + t.id, patch);
      state.tasks = state.tasks.map(x => x.id === task.id ? task : x); renderTasks(); if (state.me.role !== 'staff') renderPeople();
      toast(msg || (patch.status === 'done' ? 'Marked done' : patch.status === 'doing' ? 'Started' : patch.status ? 'Moved back to To do' : 'Saved'));
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  async function delTask(t) {
    state.confirm = null;
    try { await api('DELETE', '/api/tasks/' + t.id); state.tasks = state.tasks.filter(x => x.id !== t.id); render(); toast('Task deleted'); }
    catch (err) { toast(err.message); renderTasks(); }
  }
  ['#fPerson', '#fPri'].forEach(s => $(s).addEventListener('change', renderTasks));
  $('#fText').addEventListener('input', renderTasks);

  /* task dialog */
  function assignable() {
    const active = state.users.filter(u => u.active);
    if (state.me.role === 'owner') return active.filter(u => u.role !== 'owner');
    return active;
  }
  function openTask(t) {
    state.editing = t || null;
    $('#taskForm').reset(); showErr('#taskError');
    const sel = $('#tWho'); sel.replaceChildren();
    const ph = el('option', null, 'Choose a person'); ph.value = ''; sel.append(ph);
    const people = assignable();
    if (state.me.role === 'owner') {
      for (const m of people.filter(u => u.role === 'manager')) {
        const g = el('optgroup'); g.label = m.name + '’s team';
        const om = el('option', null, m.name + ' (manager)'); om.value = m.id; g.append(om);
        for (const s of people.filter(u => u.managerId === m.id)) { const o = el('option', null, s.name + (s.title ? ' · ' + s.title : '')); o.value = s.id; g.append(o); }
        sel.append(g);
      }
    } else {
      for (const u of people) { const o = el('option', null, u.id === state.me.id ? u.name + ' (me)' : u.name + (u.title ? ' · ' + u.title : '')); o.value = u.id; sel.append(o); }
    }
    if (t) { $('#tTitle').value = t.title; sel.value = String(t.assigneeId); $('#tPri').value = t.priority; $('#tDue').value = t.due; $('#tNotes').value = t.notes; }
    else { const fp = $('#fPerson').value; if (fp && !fp.startsWith('team:')) sel.value = fp; }
    $('#taskDlgTitle').textContent = t ? 'Edit task' : 'Assign task';
    $('#taskSave').textContent = t ? 'Save changes' : 'Assign task';
    if (!people.length || (state.me.role === 'owner' && !people.length)) showErr('#taskError', 'Add people on the People tab first.');
    $('#taskDlg').showModal(); $('#tTitle').focus();
  }
  $('#newTaskBtn').onclick = () => openTask(null);
  $('#taskForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#taskError');
    const body = { title: $('#tTitle').value.trim(), assigneeId: Number($('#tWho').value), priority: $('#tPri').value, due: $('#tDue').value, notes: $('#tNotes').value.trim() };
    if (!body.assigneeId) return showErr('#taskError', 'Choose who this task is for.');
    const b = $('#taskSave'); b.disabled = true;
    try {
      if (state.editing) { const { task } = await api('PATCH', '/api/tasks/' + state.editing.id, body); state.tasks = state.tasks.map(x => x.id === task.id ? task : x); toast('Task updated'); }
      else { const { task } = await api('POST', '/api/tasks', body); state.tasks.unshift(task); toast('Assigned to ' + task.assigneeName); }
      $('#taskDlg').close(); render();
    } catch (err) { showErr('#taskError', err.message); }
    finally { b.disabled = false; }
  });

  /* note dialog */
  let noteTask = null;
  function openNote(t) { noteTask = t; showErr('#noteError'); $('#noteFor').textContent = t.title; $('#nText').value = t.progress || ''; $('#noteDlg').showModal(); $('#nText').focus(); }
  $('#noteForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (await patchTask(noteTask, { progress: $('#nText').value.trim() }, 'Note saved')) $('#noteDlg').close();
  });

  /* ---------- people ---------- */
  function openCount(id) { const mine = state.tasks.filter(t => t.assigneeId === id); return { open: mine.filter(t => t.status !== 'done').length, late: mine.filter(isLate).length }; }
  function personRow(u, tag) {
    const li = el('li');
    const wb = el('div', 'who-big'); wb.append(el('span', 'av lg', initials(u.name)));
    const txt = el('div'); txt.append(el('b', null, u.name)); txt.append(el('small', null, [u.title, 'ID: ' + u.username].filter(Boolean).join(' · '))); wb.append(txt);
    li.append(wb);
    if (!u.active) li.append(el('span', 'tag off', 'Deactivated'));
    else if (tag) li.append(el('span', 'tag', tag));
    const c = openCount(u.id); li.append(el('span', 'load', `${c.open} open${c.late ? ` · ${c.late} overdue` : ''}`));
    if (u.id === state.me.id) return li;
    const mini = el('div', 'mini');
    const key = 'user:' + u.id;
    if (state.confirm === key) {
      mini.append(el('span', null, u.active ? 'Deactivate? They won\'t be able to sign in.' : 'Reactivate this account?'),
        btn(u.active ? 'Deactivate' : 'Reactivate', 'ghost danger', () => setActive(u, !u.active)),
        btn('Cancel', 'ghost', () => { state.confirm = null; renderPeople(); }));
      li.append(mini); return li;
    }
    if (state.me.role === 'owner' && u.role === 'staff' && u.active) {
      const mgrs = state.users.filter(x => x.role === 'manager' && x.active);
      if (mgrs.length > 1) {
        const s = el('select'); s.setAttribute('aria-label', 'Move ' + u.name + ' to another manager'); s.id = 'move-' + u.id;
        for (const m of mgrs) { const o = el('option', null, 'Reports to ' + m.name); o.value = m.id; s.append(o); }
        s.value = String(u.managerId); s.onchange = () => moveStaff(u, Number(s.value)); mini.append(s);
      }
    }
    mini.append(btn('Reset password', 'ghost', () => openReset(u)), btn(u.active ? 'Deactivate' : 'Reactivate', 'ghost' + (u.active ? ' danger' : ''), () => { state.confirm = key; renderPeople(); }));
    li.append(mini); return li;
  }
  function renderPeople() {
    const host = $('#peopleList'); host.replaceChildren();
    const me = state.me;
    if (me.role === 'manager') {
      const g = el('section', 'group');
      const h = el('div', 'group-h'); h.append(el('h2', null, 'My staff')); g.append(h);
      const staff = state.users.filter(u => u.role === 'staff');
      if (!staff.length) g.append(el('p', 'empty-group', 'No staff yet. Use “Add staff member” to create their login.'));
      const ul = el('ul', 'plist'); staff.forEach(s => ul.append(personRow(s))); g.append(ul);
      host.append(g); return;
    }
    const managers = state.users.filter(u => u.role === 'manager');
    if (!managers.length) { const g = el('section', 'group'); g.append(el('p', 'empty-group', 'No managers yet. Start by adding a manager, then add the staff who report to them.')); host.append(g); }
    for (const m of managers) {
      const g = el('section', 'group');
      const ul = el('ul', 'plist');
      const head = personRow(m, 'Manager'); head.classList.add('mgr'); ul.append(head);
      const staff = state.users.filter(u => u.managerId === m.id);
      staff.forEach(s => ul.append(personRow(s))); g.append(ul);
      if (!staff.length) g.append(el('p', 'empty-group', 'No staff report to ' + m.name + ' yet.'));
      host.append(g);
    }
    const orphans = state.users.filter(u => u.role === 'staff' && !managers.some(m => m.id === u.managerId));
    if (orphans.length) { const g = el('section', 'group'); const gh = el('div', 'group-h'); gh.append(el('h2', null, 'Without a manager')); g.append(gh); const ul = el('ul', 'plist'); orphans.forEach(s => ul.append(personRow(s))); g.append(ul); host.append(g); }
  }
  async function setActive(u, active) {
    state.confirm = null;
    try { const { user } = await api('PATCH', '/api/users/' + u.id, { active }); state.users = state.users.map(x => x.id === user.id ? user : x); toast(active ? u.name + ' reactivated' : u.name + ' deactivated'); }
    catch (err) { toast(err.message); }
    render();
  }
  async function moveStaff(u, managerId) {
    try { const { user } = await api('PATCH', '/api/users/' + u.id, { managerId }); state.users = state.users.map(x => x.id === user.id ? user : x); toast(u.name + ' moved to ' + userById(managerId).name + '’s team'); }
    catch (err) { toast(err.message); }
    render();
  }

  /* person dialog */
  function openPerson() {
    $('#personForm').reset(); showErr('#personError');
    const owner = state.me.role === 'owner';
    $('#roleRow').hidden = !owner;
    const sel = $('#uMgr'); sel.replaceChildren();
    for (const m of state.users.filter(u => u.role === 'manager' && u.active)) { const o = el('option', null, m.name); o.value = m.id; sel.append(o); }
    $('#uRole').value = owner && !sel.options.length ? 'manager' : 'staff';
    syncRole();
    $('#uPass').value = tempPassword();
    $('#personDlg').showModal(); $('#uName').focus();
  }
  function syncRole() {
    const staff = $('#uRole').value === 'staff';
    $('#uMgrWrap').hidden = !staff || state.me.role !== 'owner';
    $('#personDlgTitle').textContent = state.me.role === 'owner' ? (staff ? 'Add staff member' : 'Add manager') : 'Add staff member';
    $('#personSave').textContent = staff ? 'Add staff member' : 'Add manager';
  }
  $('#uRole').addEventListener('change', syncRole);
  $('#newPersonBtn').onclick = openPerson;
  $('#personForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#personError');
    const role = state.me.role === 'owner' ? $('#uRole').value : 'staff';
    if (role === 'staff' && state.me.role === 'owner' && !$('#uMgr').value) return showErr('#personError', 'Add a manager first, then add staff under them.');
    const body = { role, managerId: Number($('#uMgr').value) || undefined, name: $('#uName').value.trim(), title: $('#uTitle').value.trim(), username: $('#uLogin').value.trim(), password: $('#uPass').value };
    const b = $('#personSave'); b.disabled = true;
    try {
      const { user } = await api('POST', '/api/users', body);
      state.users.push(user); $('#personDlg').close(); render();
      toast(`${user.name} added. Login ID: ${user.username}`);
    } catch (err) { showErr('#personError', err.message); }
    finally { b.disabled = false; }
  });

  /* reset dialog */
  let resetUser = null;
  function openReset(u) { resetUser = u; showErr('#resetError'); $('#resetFor').textContent = `${u.name} (login ID: ${u.username})`; $('#rPass').value = tempPassword(); $('#resetDlg').showModal(); $('#rPass').select(); }
  $('#resetForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#resetError');
    try { await api('PATCH', '/api/users/' + resetUser.id, { password: $('#rPass').value }); $('#resetDlg').close(); toast('Password reset for ' + resetUser.name); }
    catch (err) { showErr('#resetError', err.message); }
  });

  document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

  boot();
})();
