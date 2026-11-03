'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const STATUS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
  const PRI = { high: 0, medium: 1, low: 2 };
  const ROLE = { owner: 'Owner', partner: 'Partner', manager: 'Partner', staff: 'Staff' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const state = { me: null, config: {}, users: [], tasks: [], clients: [], categories: [], rules: [], tab: 'tasks', confirm: null, editing: null, clientId: null };

  /* Common Pakistan filing deadlines as starting points. Change the day if a notification moves it. */
  const PRESETS = [
    { label: 'Sales Tax Return (FBR)', title: 'Sales Tax Return', cat: 'Sales Tax', frequency: 'monthly', dueDay: 18 },
    { label: 'Annex H', title: 'Annex H', cat: 'Annex H', frequency: 'monthly', dueDay: 18 },
    { label: 'Withholding Statement', title: 'Withholding Tax Statement', cat: 'Withholding Tax', frequency: 'quarterly', dueDay: 20, months: [1, 4, 7, 10] },
    { label: 'Income Tax Return – Individual/AOP', title: 'Income Tax Return', cat: 'Income Tax', frequency: 'annual', dueDay: 30, dueMonth: 9 },
    { label: 'Income Tax Return – Company', title: 'Income Tax Return', cat: 'Income Tax', frequency: 'annual', dueDay: 31, dueMonth: 12 },
    { label: 'PRA Return', title: 'PRA Sales Tax on Services Return', cat: 'Provincial Sales Tax', frequency: 'monthly', dueDay: 18 },
    { label: 'SRB Return', title: 'SRB Sales Tax on Services Return', cat: 'Provincial Sales Tax', frequency: 'monthly', dueDay: 18 },
  ];

  /* ---------- utilities ---------- */
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls, fn) { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }
  function opt(sel, value, text) { const o = el('option', null, text); o.value = value; sel.append(o); return o; }
  const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const today = () => state.config.today && new Date().toDateString() === state.loadedOn ? state.config.today : (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const fmtTime = ms => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const isLate = t => t.status !== 'done' && t.due && t.due < today();
  const userById = id => state.users.find(u => u.id === id);
  const clientById = id => state.clients.find(c => c.id === id);
  const lead = () => state.me && state.me.role !== 'staff';
  let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }
  function showErr(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }
  function tempPassword() { const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'; const a = new Uint32Array(7); crypto.getRandomValues(a); return 'Cbg-' + [...a].map(n => c[n % c.length]).join('') + (a[0] % 90 + 10); }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(what + ' copied'); } catch { toast('Copy didn\'t work here. Select the text and copy it.'); }
  }

  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CBG': '1' }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await res.json(); } catch { }
    if (res.status === 401 && url !== '/api/login') { state.me = null; show('login'); }
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
    return data;
  }

  /* ---------- auth views ---------- */
  function show(view) { $('#loginView').hidden = view !== 'login'; $('#pwView').hidden = view !== 'password'; $('#appView').hidden = view !== 'app'; }
  async function boot() {
    try { const r = await api('GET', '/api/me'); state.me = r.user; state.config = r.config; state.loadedOn = new Date().toDateString(); }
    catch { show('login'); return; }
    if (state.me.mustChange) return openPassword(true);
    enterApp();
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#loginError'); const b = e.submitter; b.disabled = true;
    try {
      await api('POST', '/api/login', { username: $('#lUser').value.trim(), password: $('#lPass').value });
      $('#loginForm').reset(); await boot();
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
    try { await api('POST', '/api/me/password', { current: $('#pCur').value, next: $('#pNew').value }); state.me.mustChange = false; toast('Password saved'); enterApp(); }
    catch (err) { showErr('#pwError', err.message); }
    finally { b.disabled = false; }
  });
  $('#logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch { } state.me = null; show('login'); $('#lUser').focus(); };

  const mgmt = () => state.me && (state.me.role === 'owner' || state.me.role === 'partner');
  const seesAll = () => state.me && (state.me.role === 'owner' || state.me.role === 'partner');
  async function enterApp() {
    show('app'); const me = state.me;
    $('#meName').textContent = me.name; $('#meRole').textContent = ROLE[me.role] + (me.title && me.title !== ROLE[me.role] ? ' · ' + me.title : '');
    document.querySelectorAll('#tabs [data-role="assign"]').forEach(b => b.hidden = !lead());
    document.querySelectorAll('#tabs [data-role="mgmt"]').forEach(b => b.hidden = !mgmt());
    $('#newTaskBtn').hidden = false; $('#newTaskBtn').textContent = lead() ? '+ Assign task' : '+ Add my task'; $('#fPersonWrap').hidden = !lead(); $('#fPartnerWrap').hidden = !seesAll();
    $('#newClientBtn').hidden = !mgmt(); $('#cMgrWrap').hidden = !seesAll();
    $('#credsOff').hidden = !!state.config.credsEnabled;
    $('#tasksTitle').textContent = { staff: 'My tasks', manager: 'My team\'s tasks', partner: 'Tasks', owner: 'All tasks' }[me.role];
    $('#tasksSub').textContent = {
      staff: 'Your tasks. Update the status as you go, or add your own with “Add my task”.',
      manager: 'Tasks for you and the staff who report to you.',
      partner: 'Business tasks for you and your staff, tasks you assigned, and tasks you are involved in as a partner.',
      owner: 'Every business task across the firm. Personal tasks stay private to the person who added them.',
    }[me.role];
    $('#feedSubBiz').textContent = 'Business tasks you add here can be shared with partners.';
    $('#clientsSub').textContent = { owner: 'All clients, their registrations and portal logins.', partner: 'All clients and their portal logins. You can edit the clients you are in charge of.', manager: 'Clients assigned to you and your staff.', staff: 'Clients you work on.' }[me.role];
    $('#peopleSub').textContent = me.role === 'owner' ? 'Partners and the staff who report to each of them.' : 'The staff who report to you.';
    $('#newPersonBtn').textContent = me.role === 'owner' ? '+ Add person' : '+ Add staff member';
    $('#catPanel').hidden = me.role !== 'owner';
    if ((!lead() && ['recurring', 'feed'].includes(state.tab)) || (!mgmt() && state.tab === 'people')) state.tab = 'tasks';
    setTab(state.tab);
    await refresh();
  }
  async function refresh() {
    try {
      const calls = [api('GET', '/api/users'), api('GET', '/api/tasks'), api('GET', '/api/clients'), api('GET', '/api/categories')];
      if (lead()) calls.push(api('GET', '/api/recurring'));
      const [u, t, c, k, r] = await Promise.all(calls);
      state.users = u.users; state.tasks = t.tasks; state.clients = c.clients; state.categories = k.categories; state.rules = r ? r.rules : [];
      render();
    } catch (err) { if (err.status !== 401) toast(err.message); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me && !$('#appView').hidden && !document.querySelector('dialog[open]')) refresh(); });
  setInterval(() => { if (state.me && !document.hidden && !$('#appView').hidden && !document.querySelector('dialog[open]')) refresh(); }, 60000);

  function setTab(t) {
    state.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    for (const p of ['tasks', 'feed', 'clients', 'recurring', 'people']) $('#' + p + 'Page').hidden = p !== t;
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { setTab(b.dataset.tab); render(); } });
  function render() {
    renderFilters(); renderBoards(); renderClients();
    if (lead()) renderRules();
    if (mgmt()) renderPeople();
  }
  function renderBoards() { renderTasks(); if (lead()) renderFeed(); }

  /* ---------- filters ---------- */
  function fillSelect(sel, first, items) {
    const keep = sel.value; sel.replaceChildren(); if (first) opt(sel, '', first);
    for (const [v, t] of items) opt(sel, String(v), t);
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  }
  // The people this user may pick, grouped the same way the server allows assigning
  function addPeopleOptions(sel, forFilter) {
    const me = state.me; const active = state.users.filter(u => u.active);
    const label = u => u.name + (u.title ? ' · ' + u.title : '');
    if (me.role === 'staff') return;
    opt(sel, me.id, forFilter ? 'My own tasks' : me.name + ' (me)');
    // One group per partner with the staff who report to them; my own team first
    const partners = active.filter(u => u.role === 'partner').sort((x, y) => (y.id === me.id) - (x.id === me.id) || x.name.localeCompare(y.name));
    for (const p of partners) {
      const isMe = p.id === me.id;
      const staff = active.filter(u => u.role === 'staff' && u.managerId === p.id);
      if (isMe && !staff.length) continue;
      const g = el('optgroup'); g.label = isMe ? 'My team' : p.name + '’s team';
      if (forFilter && staff.length) { const o1 = el('option', null, isMe ? 'My whole team' : 'Whole team of ' + p.name); o1.value = 'team:' + p.id; g.append(o1); }
      if (!isMe) { const op = el('option', null, p.name + ' (partner)'); op.value = p.id; g.append(op); }
      for (const s of staff) { const o = el('option', null, label(s)); o.value = s.id; g.append(o); }
      sel.append(g);
    }
    const others = active.filter(u => u.role === 'staff' && !partners.some(p => p.id === u.managerId));
    if (others.length) { const g = el('optgroup'); g.label = 'Other staff'; for (const s of others) { const o = el('option', null, label(s)); o.value = s.id; g.append(o); } sel.append(g); }
  }
  function renderFilters() {
    const sel = $('#fPerson'); const keep = sel.value;
    sel.replaceChildren(); opt(sel, '', 'Everyone I can see'); addPeopleOptions(sel, true);
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
    fillSelect($('#fPartner'), 'Any partner', state.users.filter(u => u.role === 'partner' || u.role === 'owner').map(u => [u.id, u.name + (u.role === 'owner' ? ' (owner)' : '')]));
    fillSelect($('#fClient'), 'All clients', state.clients.filter(c => c.active).map(c => [c.id, c.name]));
    fillSelect($('#fCat'), 'All categories', state.categories.map(c => [c.id, c.name]));
    if (seesAll()) fillSelect($('#cMgr'), 'All partners', state.users.filter(u => u.role === 'partner').map(u => [u.id, u.name]));
  }

  /* ---------- tasks ---------- */
  function filteredTasks() {
    const p = $('#fPerson').value, pt = $('#fPartner').value, cl = $('#fClient').value, ct = $('#fCat').value, pri = $('#fPri').value, q = $('#fText').value.trim().toLowerCase();
    return state.tasks.filter(t => {
      if (t.visibility === 'personal') return false; // personal tasks live only in My feed
      if (p.startsWith('team:')) { const mid = Number(p.slice(5)); const u = userById(t.assigneeId); if (!(t.assigneeId === mid || (u && u.managerId === mid))) return false; }
      else if (p && t.assigneeId !== Number(p)) return false;
      if (pt && !t.partnerIds.includes(Number(pt))) return false;
      if (cl && t.clientId !== Number(cl)) return false;
      if (ct && t.categoryId !== Number(ct)) return false;
      if (pri && t.priority !== pri) return false;
      if (q && !`${t.title} ${t.notes} ${t.progress} ${t.assigneeName} ${t.clientName} ${t.categoryName} ${t.partnerNames.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function drawLanes(host, tasks, emptyText) {
    host.replaceChildren();
    for (const [key, label] of STATUS) {
      const lane = el('section', 'lane'); lane.dataset.s = key;
      const list = tasks.filter(t => t.status === key).sort(key === 'done' ? (a, b) => (b.doneAt || 0) - (a.doneAt || 0)
        : (a, b) => (isLate(b) - isLate(a)) || (a.due || '9999').localeCompare(b.due || '9999') || (PRI[a.priority] - PRI[b.priority]));
      const h = el('div', 'lane-h'); h.append(el('h3', null, label), el('span', null, String(list.length))); lane.append(h);
      const shown = key === 'done' ? list.slice(0, 40) : list;
      if (!list.length) lane.append(el('div', 'lane-empty', key === 'todo' && emptyText ? emptyText : 'Nothing here'));
      for (const t of shown) lane.append(card(t));
      if (list.length > shown.length) lane.append(el('div', 'lane-empty', `Showing the latest ${shown.length} of ${list.length} done tasks`));
      host.append(lane);
    }
  }
  function renderTasks() {
    const tasks = filteredTasks();
    $('#sOpen').textContent = tasks.filter(t => t.status !== 'done').length;
    $('#sDoing').textContent = tasks.filter(t => t.status === 'doing').length;
    $('#sLate').textContent = tasks.filter(isLate).length;
    $('#sDone').textContent = tasks.filter(t => t.status === 'done').length;
    const none = !state.tasks.some(t => t.visibility !== 'personal');
    drawLanes($('#lanes'), tasks, none ? (lead() ? 'No tasks yet. Use “Assign task” to give someone work.' : 'No tasks assigned to you yet.') : null);
  }
  function renderFeed() {
    const ty = $('#feedType').value, q = $('#feedText').value.trim().toLowerCase();
    const mineAll = state.tasks.filter(t => t.assigneeId === state.me.id);
    const mine = mineAll.filter(t => (!ty || t.visibility === ty) && (!q || `${t.title} ${t.notes} ${t.progress} ${t.clientName}`.toLowerCase().includes(q)));
    drawLanes($('#feedLanes'), mine, mineAll.length ? null : 'Nothing here yet. Use “Add my task” to add your first to-do.');
  }
  $('#feedType').addEventListener('change', renderFeed);
  $('#feedText').addEventListener('input', renderFeed);
  function card(t) {
    const me = state.me; const mine = t.assigneeId === me.id;
    const c = el('article', 'card' + (isLate(t) ? ' overdue' : ''));
    const tags = el('div', 'meta');
    if (t.visibility === 'personal') tags.append(el('span', 'chip personal', 'Personal · only you'));
    if (t.clientName) tags.append(el('span', 'chip client', t.clientName));
    if (t.categoryName) tags.append(el('span', 'chip', t.categoryName));
    if (me.role === 'partner' && !mine && t.createdBy !== me.id && t.partnerIds.includes(me.id)) tags.append(el('span', 'chip watch', 'Following as partner'));
    if (t.selfAdded && !mine && t.visibility !== 'personal') tags.append(el('span', 'chip watch', 'Self-added'));
    if (t.recurringId) tags.append(el('span', 'repeat', '↻ Recurring'));
    if (tags.children.length) c.append(tags);
    c.append(el('p', 'card-t', t.title));
    if (t.notes) c.append(el('p', 'card-n', t.notes));
    if (t.progress) { const p = el('p', 'progress'); p.append(el('b', null, 'Progress'), document.createTextNode(t.progress)); c.append(p); }
    if (t.partnerNames.length) { const p = el('p', 'partners-line'); p.append(document.createTextNode('Partners: '), el('b', null, t.partnerNames.join(', '))); c.append(p); }
    const m = el('div', 'meta');
    m.append(el('span', 'pill p-' + t.priority, t.priority));
    if (lead() || !mine) { const w = el('span', 'who'); w.append(el('span', 'av', initials(t.assigneeName)), document.createTextNode(mine ? 'Me' : t.assigneeName)); m.append(w); }
    if (t.due) m.append(el('span', isLate(t) ? 'late' : '', (isLate(t) ? 'Overdue · ' : 'Due ') + fmtDate(t.due)));
    if (t.createdBy !== me.id && !t.recurringId) m.append(el('span', null, 'From ' + t.createdByName));
    c.append(m);
    if (!(mine || t.canEdit)) return c;
    const a = el('div', 'actions'); const key = 'task:' + t.id;
    if (state.confirm === key) {
      const cf = el('div', 'confirm'); cf.append(el('span', null, 'Delete this task?'), btn('Delete', 'ghost danger', () => delTask(t)), btn('Keep', 'ghost', () => { state.confirm = null; renderBoards(); }));
      a.append(cf); c.append(a); return c;
    }
    for (const [k] of STATUS) if (k !== t.status) a.append(btn(k === 'done' ? 'Mark done' : k === 'doing' ? 'Start' : 'Back to To do', 'ghost', () => patchTask(t, { status: k })));
    a.append(btn(t.progress ? 'Edit note' : 'Add note', 'ghost', () => openNote(t)));
    if (t.clientId && clientById(t.clientId)) a.append(btn('Client logins', 'ghost', () => { state.clientId = t.clientId; setTab('clients'); render(); }));
    if (t.canEdit) a.append(btn('Edit', 'ghost', () => openTask(t)));
    if (t.canDelete) a.append(btn('Delete', 'ghost danger', () => { state.confirm = key; renderBoards(); }));
    c.append(a); return c;
  }
  async function patchTask(t, patch, msg) {
    try {
      const { task } = await api('PATCH', '/api/tasks/' + t.id, patch);
      state.tasks = state.tasks.map(x => x.id === task.id ? task : x); renderBoards(); if (mgmt()) renderPeople();
      toast(msg || (patch.status === 'done' ? 'Marked done' : patch.status === 'doing' ? 'Started' : 'Moved back to To do'));
      return true;
    } catch (err) { toast(err.message); return false; }
  }
  async function delTask(t) {
    state.confirm = null;
    try { await api('DELETE', '/api/tasks/' + t.id); state.tasks = state.tasks.filter(x => x.id !== t.id); render(); toast('Task deleted'); }
    catch (err) { toast(err.message); renderBoards(); }
  }
  ['#fPerson', '#fPartner', '#fClient', '#fCat', '#fPri'].forEach(s => $(s).addEventListener('change', renderTasks));
  $('#fText').addEventListener('input', renderTasks);

  /* shared pickers */
  function fillPeople(sel) { sel.replaceChildren(); opt(sel, '', 'Choose a person'); addPeopleOptions(sel, false); }
  function fillClients(sel, includeId) { sel.replaceChildren(); opt(sel, '', 'No client (internal)'); for (const c of state.clients.filter(c => c.active || c.id === includeId)) opt(sel, c.id, c.name + (c.code ? ` (${c.code})` : '')); }
  function fillCats(sel) { sel.replaceChildren(); opt(sel, '', 'No category'); for (const c of state.categories) opt(sel, c.id, c.name); }
  function fillPartnerChecks(box, selected) {
    box.replaceChildren();
    // Everyone who can be named as a partner on a task: the owner and all active partners, including me
    const ps = state.users.filter(u => (u.role === 'partner' || u.role === 'owner') && (u.active || selected.includes(u.id)))
      .sort((x, y) => (x.role === 'owner') - (y.role === 'owner') || x.name.localeCompare(y.name));
    if (!ps.some(u => u.role === 'partner')) box.append(el('span', 'help', 'No partners added yet. The owner adds them on the People tab.'));
    for (const p of ps) {
      const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.value = p.id; i.id = box.id + '-' + p.id; i.checked = selected.includes(p.id);
      l.append(i, document.createTextNode(p.name + (p.id === state.me.id ? ' (me)' : p.role === 'owner' ? ' (owner)' : ''))); box.append(l);
    }
  }
  const checkedIds = box => [...box.querySelectorAll('input:checked')].map(i => Number(i.value));
  // When a client is chosen, pre-select a person who works on it
  function suggestPerson(clientSel, whoSel) {
    clientSel.onchange = () => {
      const c = clientById(Number(clientSel.value)); if (!c || whoSel.value) return;
      const pick = c.staffIds.find(id => userById(id)?.active) ?? (userById(c.managerId) ? c.managerId : null);
      if (pick != null && [...whoSel.options].some(o => o.value === String(pick))) whoSel.value = String(pick);
    };
  }

  /* task dialog: 'assign' gives work to someone; 'own' adds to my feed as Business or Personal */
  let taskMode = 'assign';
  function syncTaskType() {
    const own = taskMode === 'own'; const personal = own && $('#tTypePer').checked;
    const staff = state.me.role === 'staff';
    $('#tTypeWrap').hidden = !own || staff;
    $('#tWhoWrap').hidden = own; $('#tWho').required = !own;
    $('#tPartnersWrap').hidden = personal || staff;
    // Category and client are compulsory when assigning, and for anything staff add
    const req = !personal && (!own || staff || (state.editing && state.editing.createdBy !== state.me.id));
    $('#tCatReq').hidden = !req; $('#tClientReq').hidden = !req;
    $('#tCat').required = req; $('#tClient').required = req;
    $('#tCat').options[0].textContent = req ? 'Choose a category' : 'No category';
    $('#tClient').options[0].textContent = req ? 'Choose a client' : 'No client (internal)';
    const needs = own && !personal && state.me.role === 'manager';
    $('#tPartnersWrap').classList.toggle('required', needs);
    $('#tPartnersHelp').textContent = needs ? 'Business tasks you add for yourself must name at least one partner, who can then follow them.'
      : personal ? '' : 'Partners you tick can see and follow this task.';
  }
  document.querySelectorAll('input[name="tType"]').forEach(r => r.addEventListener('change', syncTaskType));
  function openTask(t, mode) {
    state.editing = t || null;
    taskMode = t ? (t.assigneeId === state.me.id && t.createdBy === state.me.id ? 'own' : 'assign') : (mode || 'assign');
    $('#taskForm').reset(); showErr('#taskError');
    fillCats($('#tCat')); fillClients($('#tClient'), t?.clientId); fillPeople($('#tWho'));
    suggestPerson($('#tClient'), $('#tWho'));
    fillPartnerChecks($('#tPartners'), t ? t.partnerIds : []);
    if (t) {
      $('#tTitle').value = t.title; $('#tWho').value = String(t.assigneeId); $('#tPri').value = t.priority; $('#tDue').value = t.due; $('#tNotes').value = t.notes;
      $('#tCat').value = t.categoryId ?? ''; $('#tClient').value = t.clientId ?? '';
      $('#tTypePer').checked = t.visibility === 'personal'; $('#tTypeBiz').checked = t.visibility !== 'personal';
    } else if (taskMode === 'assign') {
      const fp = $('#fPerson').value; if (fp && !fp.startsWith('team:') && [...$('#tWho').options].some(o => o.value === fp)) $('#tWho').value = fp;
      if ($('#fClient').value) $('#tClient').value = $('#fClient').value;
      if ($('#fCat').value) $('#tCat').value = $('#fCat').value;
    }
    $('#taskDlgTitle').textContent = t ? 'Edit task' : taskMode === 'own' ? 'Add my task' : 'Assign task';
    $('#taskSave').textContent = t ? 'Save changes' : taskMode === 'own' ? 'Add task' : 'Assign task';
    syncTaskType();
    if (taskMode === 'assign' && $('#tWho').options.length < 2) showErr('#taskError', 'Add people on the People tab first.');
    $('#taskDlg').showModal(); $('#tTitle').focus();
  }
  $('#newTaskBtn').onclick = () => openTask(null, lead() ? 'assign' : 'own');
  $('#newOwnBtn').onclick = () => openTask(null, 'own');
  $('#taskForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#taskError');
    const own = taskMode === 'own'; const personal = own && $('#tTypePer').checked;
    const body = { title: $('#tTitle').value.trim(), priority: $('#tPri').value, due: $('#tDue').value, notes: $('#tNotes').value.trim(),
      categoryId: $('#tCat').value ? Number($('#tCat').value) : null, clientId: $('#tClient').value ? Number($('#tClient').value) : null };
    if (own) { body.visibility = personal ? 'personal' : 'business'; if (!personal) body.assigneeId = state.me.id; }
    else body.assigneeId = Number($('#tWho').value);
    if (!personal && state.me.role !== 'staff') body.partnerIds = checkedIds($('#tPartners'));
    if (!own && !body.assigneeId) return showErr('#taskError', 'Choose who this task is for.');
    if ($('#tCat').required && !body.categoryId) return showErr('#taskError', 'Choose a task category.');
    if ($('#tClient').required && !body.clientId) return showErr('#taskError', 'Choose a client.');
    if (own && !personal && state.me.role === 'manager' && !body.partnerIds.length) return showErr('#taskError', 'Choose at least one partner who can follow this task.');
    const b = $('#taskSave'); b.disabled = true;
    try {
      if (state.editing) { const { task } = await api('PATCH', '/api/tasks/' + state.editing.id, body); state.tasks = state.tasks.map(x => x.id === task.id ? task : x); toast('Task updated'); }
      else {
        const { task } = await api('POST', '/api/tasks', body); state.tasks.unshift(task);
        toast(personal ? 'Added to your feed. Only you can see it.' : own ? (state.me.role === 'staff' ? 'Task added' : 'Added to your feed') : 'Assigned to ' + task.assigneeName);
      }
      $('#taskDlg').close(); render();
    } catch (err) { showErr('#taskError', err.message); }
    finally { b.disabled = false; }
  });
  let noteTask = null;
  function openNote(t) { noteTask = t; $('#noteFor').textContent = t.title; $('#nText').value = t.progress || ''; $('#noteDlg').showModal(); $('#nText').focus(); }
  $('#noteForm').addEventListener('submit', async e => { e.preventDefault(); if (await patchTask(noteTask, { progress: $('#nText').value.trim() }, 'Note saved')) $('#noteDlg').close(); });

  /* ---------- clients ---------- */
  function filteredClients() {
    const q = $('#cSearch').value.trim().toLowerCase(), mgr = $('#cMgr').value, all = $('#cShow').value === 'all';
    return state.clients.filter(c => (all || c.active) && (!mgr || c.managerId === Number(mgr)) &&
      (!q || `${c.name} ${c.code} ${c.ntn} ${c.strn} ${c.cnic} ${c.contactPerson}`.toLowerCase().includes(q)));
  }
  function renderClients() {
    const list = $('#clientList'); list.replaceChildren();
    const items = filteredClients();
    if (!items.length) list.append(el('p', 'empty-state', state.clients.length ? 'No clients match.' : mgmt() ? 'No clients yet. Use “Add client” to create the first one.' : 'No clients have been assigned to you yet.'));
    if (state.clientId && !state.clients.some(c => c.id === state.clientId)) state.clientId = null;
    if (!state.clientId && items.length && matchMedia('(min-width: 861px)').matches) state.clientId = items[0].id;
    for (const c of items) {
      const b = btn('', 'client-item' + (c.id === state.clientId ? ' on' : ''), () => { state.clientId = c.id; renderClients(); if (!matchMedia('(min-width: 861px)').matches) $('#clientDetail').scrollIntoView({ block: 'start' }); });
      b.setAttribute('role', 'listitem');
      b.append(el('b', null, c.name));
      const open = state.tasks.filter(t => t.clientId === c.id && t.status !== 'done').length;
      b.append(el('small', null, [c.code, c.entityType, c.ntn && 'NTN ' + c.ntn].filter(Boolean).join(' · ') || ' '));
      const s = el('small', null, `${open} open task${open === 1 ? '' : 's'}` + (c.managerName ? ' · ' + c.managerName : ''));
      b.append(s); if (!c.active) b.append(el('small', 'off', 'Archived'));
      list.append(b);
    }
    renderClientDetail();
  }
  ['#cSearch'].forEach(s => $(s).addEventListener('input', renderClients));
  ['#cMgr', '#cShow'].forEach(s => $(s).addEventListener('change', renderClients));

  const revealed = new Map(); // `${clientId}:${auth}` -> {password,pin,timer}
  function renderClientDetail() {
    const box = $('#clientDetail'); box.replaceChildren();
    const c = clientById(state.clientId);
    if (!c) { box.append(el('p', 'empty-state', 'Select a client to see their details and portal logins.')); return; }
    const head = el('div', 'cd-head'); const h = el('div');
    h.append(el('h2', null, c.name)); h.append(el('p', 'sub', [c.code, c.entityType, c.active ? '' : 'Archived'].filter(Boolean).join(' · ')));
    head.append(h);
    const hb = el('div', 'mini');
    if (lead()) hb.append(btn('Assign task', 'ghost', () => { $('#fClient').value = String(c.id); openTask(null); $('#tClient').value = String(c.id); $('#tClient').onchange(); }));
    if (c.canEdit) hb.append(btn('Edit client', '', () => openClient(c)));
    head.append(hb); box.append(head);

    const dl = el('dl', 'facts');
    const staffNames = c.staffIds.map(id => userById(id)?.name).filter(Boolean);
    for (const [k, v] of [['NTN', c.ntn], ['STRN', c.strn], ['CNIC', c.cnic], ['Contact person', c.contactPerson], ['Phone', c.phone], ['Email', c.email], ['Partner in charge', c.managerName], ['Staff', staffNames.join(', ')]]) {
      if (!v) continue; const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.append(d);
    }
    if (dl.children.length) box.append(dl);
    if (c.notes) box.append(el('p', 'card-n', c.notes));

    const ph = el('div', 'cd-head'); ph.append(el('h3', null, 'Portal logins')); box.append(ph);
    const grid = el('div', 'portals');
    for (const auth of state.config.authorities || []) {
      const l = c.logins.find(x => x.authority === auth);
      const p = el('div', 'portal' + (l ? '' : ' empty'));
      const t = el('h4', null, auth); p.append(t);
      if (!l) { p.append(el('span', null, 'Not saved')); if (c.canEdit) { const r = el('div', 'row-btns'); r.append(btn('Add login', 'ghost', () => openPortal(c, auth, null))); p.append(r); } grid.append(p); continue; }
      const key = c.id + ':' + auth; const rv = revealed.get(key);
      const kv1 = el('div', 'kv'); kv1.append(el('span', null, 'User ID'), el('code', null, l.loginId || '—')); p.append(kv1);
      const kv2 = el('div', 'kv'); kv2.append(el('span', null, 'Password'), el('code', null, l.hasPassword ? (rv ? rv.password : '••••••••') : '—')); p.append(kv2);
      if (l.hasPin) { const kv3 = el('div', 'kv'); kv3.append(el('span', null, 'PIN'), el('code', null, rv ? rv.pin : '••••')); p.append(kv3); }
      const r = el('div', 'row-btns');
      if (l.loginId) r.append(btn('Copy ID', 'ghost', () => copy(l.loginId, 'User ID')));
      if (l.hasPassword || l.hasPin) {
        if (rv) { r.append(btn('Copy password', 'ghost', () => copy(rv.password, 'Password')), btn('Hide', 'ghost', () => { clearTimeout(rv.timer); revealed.delete(key); renderClientDetail(); })); }
        else r.append(btn('Show password', 'ghost', () => reveal(c, auth)));
      }
      if (c.canEdit) r.append(btn('Edit', 'ghost', () => openPortal(c, auth, l)));
      p.append(r); p.append(el('small', 'help', 'Updated ' + fmtTime(l.updatedAt)));
      grid.append(p);
    }
    box.append(grid);
    if (!state.config.credsEnabled) box.append(el('p', 'help', 'Passwords can\'t be saved or shown until CRED_KEY is set on the server.'));
    else box.append(el('p', 'help', 'Passwords are stored encrypted. Each time someone shows a password it is recorded, and it hides again after 30 seconds.'));

    const openTasks = state.tasks.filter(t => t.clientId === c.id && t.status !== 'done').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    const th = el('div', 'cd-head'); th.append(el('h3', null, `Open tasks (${openTasks.length})`)); box.append(th);
    if (openTasks.length) {
      const ul = el('ul', 'log');
      for (const t of openTasks.slice(0, 12)) { const li = el('li'); li.append(el('b', null, t.title)); li.append(el('span', isLate(t) ? 'late' : '', [t.assigneeName, t.due ? (isLate(t) ? 'overdue ' : 'due ') + fmtDate(t.due) : ''].filter(Boolean).join(' · '))); ul.append(li); }
      box.append(ul);
    } else box.append(el('p', 'help', 'No open tasks for this client.'));

    if (c.canEdit) {
      const lh = el('div', 'cd-head'); lh.append(el('h3', null, 'Password access log'));
      const lb = btn('Show log', 'ghost', async () => {
        try {
          const { log } = await api('GET', `/api/clients/${c.id}/access-log`);
          const ul = el('ul', 'log');
          if (!log.length) ul.append(el('li', null, 'No one has viewed these passwords yet.'));
          for (const r of log) { const li = el('li'); li.append(el('b', null, `${r.name} viewed ${r.authority}`), el('span', null, fmtTime(r.at))); ul.append(li); }
          lb.replaceWith(ul);
        } catch (err) { toast(err.message); }
      });
      box.append(lh, lb);
    }
  }
  async function reveal(c, auth) {
    try {
      const r = await api('POST', `/api/clients/${c.id}/logins/${auth}/reveal`);
      const key = c.id + ':' + auth;
      const timer = setTimeout(() => { revealed.delete(key); if (state.clientId === c.id) renderClientDetail(); }, 30000);
      revealed.set(key, { password: r.password, pin: r.pin, timer }); renderClientDetail();
    } catch (err) { toast(err.message); }
  }

  /* client dialog */
  let editClient = null;
  function staffChecks(managerId, selected) {
    const box = $('#kStaff'); box.replaceChildren();
    const staff = state.users.filter(u => u.role === 'staff' && u.active && (state.me.role === 'partner' ? u.managerId === state.me.id : (!managerId || u.managerId === managerId)));
    if (!staff.length) box.append(el('span', 'help', managerId || state.me.role === 'partner' ? 'No staff in this team yet.' : 'Choose a partner to see their staff.'));
    for (const s of staff) { const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.value = s.id; i.checked = selected.includes(s.id); i.id = 'ks-' + s.id; l.append(i, document.createTextNode(s.name)); box.append(l); }
  }
  function openClient(c) {
    editClient = c || null; $('#clientForm').reset(); showErr('#clientError');
    const type = $('#kType'); type.replaceChildren(); for (const t of state.config.entityTypes || []) opt(type, t, t);
    const owner = state.me.role === 'owner';
    $('#kMgrWrap').hidden = !owner; $('#kActiveWrap').hidden = !owner || !c;
    const mgr = $('#kMgr'); mgr.replaceChildren(); opt(mgr, '', 'No partner yet');
    for (const m of state.users.filter(u => u.role === 'partner' && (u.active || u.id === c?.managerId))) opt(mgr, m.id, m.name);
    if (c) {
      $('#kName').value = c.name; $('#kCode').value = c.code; type.value = c.entityType; $('#kNtn').value = c.ntn; $('#kStrn').value = c.strn; $('#kCnic').value = c.cnic;
      $('#kContact').value = c.contactPerson; $('#kPhone').value = c.phone; $('#kEmail').value = c.email; $('#kNotes').value = c.notes; mgr.value = c.managerId ?? ''; $('#kActive').checked = c.active;
    } else type.value = 'Company';
    staffChecks(Number(mgr.value) || null, c ? c.staffIds : []);
    mgr.onchange = () => staffChecks(Number(mgr.value) || null, [...document.querySelectorAll('#kStaff input:checked')].map(i => Number(i.value)));
    $('#clientDlgTitle').textContent = c ? 'Edit client' : 'Add client';
    $('#clientDlg').showModal(); $('#kName').focus();
  }
  $('#newClientBtn').onclick = () => openClient(null);
  $('#clientForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#clientError');
    const body = { name: $('#kName').value.trim(), code: $('#kCode').value.trim(), entityType: $('#kType').value, ntn: $('#kNtn').value.trim(), strn: $('#kStrn').value.trim(),
      cnic: $('#kCnic').value.trim(), contactPerson: $('#kContact').value.trim(), phone: $('#kPhone').value.trim(), email: $('#kEmail').value.trim(), notes: $('#kNotes').value.trim(),
      staffIds: [...document.querySelectorAll('#kStaff input:checked')].map(i => Number(i.value)) };
    if (state.me.role === 'owner') { body.managerId = $('#kMgr').value ? Number($('#kMgr').value) : null; if (editClient) body.active = $('#kActive').checked; }
    const b = $('#clientSave'); b.disabled = true;
    try {
      const { client } = editClient ? await api('PATCH', '/api/clients/' + editClient.id, body) : await api('POST', '/api/clients', body);
      state.clients = editClient ? state.clients.map(x => x.id === client.id ? client : x) : [...state.clients, client].sort((a, b) => a.name.localeCompare(b.name));
      state.clientId = client.id; $('#clientDlg').close(); render(); toast(editClient ? 'Client updated' : client.name + ' added');
    } catch (err) { showErr('#clientError', err.message); }
    finally { b.disabled = false; }
  });

  /* portal login dialog */
  let portalCtx = null;
  function openPortal(c, auth, l) {
    portalCtx = { c, auth }; $('#portalForm').reset(); showErr('#portalError');
    $('#portalTitle').textContent = auth + ' login'; $('#portalFor').textContent = c.name;
    $('#pgId').value = l?.loginId || ''; $('#portalHint').hidden = !l; $('#pgClear').closest('label').hidden = !l; $('#pgDelete').hidden = !l;
    $('#pgPass').placeholder = l?.hasPassword ? 'Saved — type to replace' : ''; $('#pgPin').placeholder = l?.hasPin ? 'Saved — type to replace' : '';
    $('#loginDlg').showModal(); $('#pgId').focus();
  }
  $('#portalForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#portalError');
    const clear = $('#pgClear').checked;
    const body = { loginId: $('#pgId').value.trim(), password: clear ? '' : ($('#pgPass').value || null), pin: clear ? '' : ($('#pgPin').value || null) };
    try {
      const { client } = await api('PUT', `/api/clients/${portalCtx.c.id}/logins/${portalCtx.auth}`, body);
      const old = revealed.get(portalCtx.c.id + ':' + portalCtx.auth); if (old) { clearTimeout(old.timer); revealed.delete(portalCtx.c.id + ':' + portalCtx.auth); }
      state.clients = state.clients.map(x => x.id === client.id ? client : x); $('#loginDlg').close(); renderClientDetail(); toast(portalCtx.auth + ' login saved');
    } catch (err) { showErr('#portalError', err.message); }
  });
  $('#pgDelete').onclick = async () => {
    if ($('#pgDelete').dataset.armed !== '1') { $('#pgDelete').dataset.armed = '1'; $('#pgDelete').textContent = 'Click again to delete'; setTimeout(() => { $('#pgDelete').dataset.armed = ''; $('#pgDelete').textContent = 'Delete login'; }, 4000); return; }
    try {
      const { client } = await api('DELETE', `/api/clients/${portalCtx.c.id}/logins/${portalCtx.auth}`);
      state.clients = state.clients.map(x => x.id === client.id ? client : x); $('#loginDlg').close(); renderClientDetail(); toast(portalCtx.auth + ' login deleted');
    } catch (err) { showErr('#portalError', err.message); }
    finally { $('#pgDelete').dataset.armed = ''; $('#pgDelete').textContent = 'Delete login'; }
  };

  /* ---------- recurring ---------- */
  function schedule(r) {
    const d = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
    if (r.frequency === 'monthly') return `Monthly · due ${d(r.dueDay)}`;
    if (r.frequency === 'quarterly') return `Quarterly · due ${d(r.dueDay)} of ${r.months.map(m => MONTHS[m - 1].slice(0, 3)).join(', ')}`;
    return `Yearly · due ${r.dueDay} ${MONTHS[(r.dueMonth || 1) - 1]}`;
  }
  function renderRules() {
    const tb = $('#ruleTable tbody'); tb.replaceChildren();
    if (!state.rules.length) { const tr = el('tr'); const td = el('td', 'empty-state', 'No recurring tasks yet. Add your monthly, quarterly and yearly returns here.'); td.colSpan = 6; tr.append(td); tb.append(tr); }
    for (const r of state.rules) {
      const tr = el('tr', r.active ? '' : 'paused');
      const t = el('td'); t.append(el('b', null, r.title)); if (r.categoryName) t.append(el('small', null, r.categoryName)); tr.append(t);
      tr.append(el('td', null, r.clientName || '—'));
      const who = el('td', null, r.assigneeName); const pn = r.partnerIds.map(id => userById(id)?.name).filter(Boolean); if (pn.length) who.append(el('small', null, 'Partners: ' + pn.join(', '))); tr.append(who);
      const s = el('td', null, schedule(r)); s.append(el('small', null, `Added to board ${r.leadDays} day${r.leadDays === 1 ? '' : 's'} before`)); tr.append(s);
      tr.append(el('td', null, r.active ? fmtDate(r.nextDue) || '—' : 'Paused'));
      const a = el('td', 'acts');
      if (r.canEdit) {
        const key = 'rule:' + r.id;
        if (state.confirm === key) a.append(el('span', null, 'Delete? Tasks already created stay. '), btn('Delete', 'ghost danger', () => delRule(r)), btn('Keep', 'ghost', () => { state.confirm = null; renderRules(); }));
        else a.append(btn(r.active ? 'Pause' : 'Resume', 'ghost', () => saveRule(r, { active: !r.active }, r.active ? 'Paused' : 'Resumed')), btn('Edit', 'ghost', () => openRule(r)), btn('Delete', 'ghost danger', () => { state.confirm = key; renderRules(); }));
      }
      tr.append(a); tb.append(tr);
    }
    // categories (owner)
    const chips = $('#catChips'); chips.replaceChildren();
    for (const c of state.categories) { const ch = el('span', 'chip', c.name); const x = btn('×', '', () => delCat(c)); x.setAttribute('aria-label', 'Remove ' + c.name); ch.append(x); chips.append(ch); }
  }
  async function saveRule(r, patch, msg) {
    try { const res = await api('PATCH', '/api/recurring/' + r.id, patch); state.rules = state.rules.map(x => x.id === r.id ? res.rule : x); if (res.created) await refresh(); else renderRules(); toast(msg); }
    catch (err) { toast(err.message); }
  }
  async function delRule(r) {
    state.confirm = null;
    try { await api('DELETE', '/api/recurring/' + r.id); state.rules = state.rules.filter(x => x.id !== r.id); renderRules(); toast('Recurring task deleted'); }
    catch (err) { toast(err.message); }
  }
  let editRule = null;
  function syncFreq() {
    const f = $('#rFreq').value;
    $('#rMonthWrap').hidden = f !== 'annual'; $('#rMonthsWrap').hidden = f !== 'quarterly';
    preview();
  }
  function preview() {
    const f = $('#rFreq').value, day = Number($('#rDay').value) || 1, leadD = Number($('#rLead').value) || 0;
    let txt = '';
    if (f === 'monthly') txt = `Due on day ${day} every month. Covers the previous month (e.g. due ${day} Nov → return for October).`;
    if (f === 'quarterly') { const ms = [...document.querySelectorAll('#rMonths input:checked')].map(i => MONTHS[Number(i.value) - 1].slice(0, 3)); txt = `Due on day ${day} of ${ms.join(', ') || '(choose months)'}. Covers the quarter that just ended.`; }
    if (f === 'annual') txt = `Due ${day} ${MONTHS[Number($('#rMonth').value) - 1]} each year, labelled with the tax year.`;
    $('#rPreview').textContent = txt + ` Appears on the task board ${leadD} day${leadD === 1 ? '' : 's'} before the due date.`;
  }
  function openRule(r) {
    editRule = r || null; $('#ruleForm').reset(); showErr('#ruleError');
    fillCats($('#rCat')); fillClients($('#rClient'), r?.clientId); fillPeople($('#rWho')); suggestPerson($('#rClient'), $('#rWho'));
    fillPartnerChecks($('#rPartners'), r ? r.partnerIds : []);
    const mSel = $('#rMonth'); mSel.replaceChildren(); MONTHS.forEach((m, i) => opt(mSel, i + 1, m));
    const box = $('#rMonths'); box.replaceChildren();
    MONTHS.forEach((m, i) => { const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.value = i + 1; c.id = 'rm-' + (i + 1); c.onchange = preview; l.append(c, document.createTextNode(m.slice(0, 3))); box.append(l); });
    const pre = $('#presets'); pre.replaceChildren(el('span', 'flabel', 'Quick start'));
    for (const p of PRESETS) pre.append(btn(p.label, '', () => applyPreset(p)));
    pre.hidden = !!r;
    if (r) {
      $('#rTitle').value = r.title; $('#rCat').value = r.categoryId ?? ''; $('#rClient').value = r.clientId ?? ''; $('#rWho').value = String(r.assigneeId);
      $('#rFreq').value = r.frequency; $('#rDay').value = r.dueDay; $('#rMonth').value = r.dueMonth || 1; $('#rLead').value = r.leadDays; $('#rPri').value = r.priority; $('#rNotes').value = r.notes;
      r.months.forEach(m => { const c = $('#rm-' + m); if (c) c.checked = true; });
    } else { $('#rPri').value = 'high'; [1, 4, 7, 10].forEach(m => $('#rm-' + m).checked = true); }
    $('#ruleDlgTitle').textContent = r ? 'Edit recurring task' : 'Add recurring task';
    syncFreq(); $('#ruleDlg').showModal(); $('#rTitle').focus();
  }
  function applyPreset(p) {
    $('#rTitle').value = p.title; $('#rFreq').value = p.frequency; $('#rDay').value = p.dueDay;
    if (p.dueMonth) $('#rMonth').value = p.dueMonth;
    document.querySelectorAll('#rMonths input').forEach(c => c.checked = (p.months || [1, 4, 7, 10]).includes(Number(c.value)));
    const cat = state.categories.find(c => c.name.toLowerCase() === p.cat.toLowerCase()); if (cat) $('#rCat').value = cat.id;
    syncFreq();
  }
  ['#rFreq'].forEach(s => $(s).addEventListener('change', syncFreq));
  ['#rDay', '#rLead'].forEach(s => $(s).addEventListener('input', preview));
  $('#rMonth').addEventListener('change', preview);
  $('#newRuleBtn').onclick = () => openRule(null);
  $('#ruleForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#ruleError');
    const body = { title: $('#rTitle').value.trim(), categoryId: $('#rCat').value ? Number($('#rCat').value) : null, clientId: $('#rClient').value ? Number($('#rClient').value) : null,
      assigneeId: Number($('#rWho').value), frequency: $('#rFreq').value, dueDay: Number($('#rDay').value), dueMonth: Number($('#rMonth').value),
      partnerIds: checkedIds($('#rPartners')), months: [...document.querySelectorAll('#rMonths input:checked')].map(i => Number(i.value)), leadDays: Number($('#rLead').value), priority: $('#rPri').value, notes: $('#rNotes').value.trim() };
    if (!body.assigneeId) return showErr('#ruleError', 'Choose who does this task.');
    const b = $('#ruleSave'); b.disabled = true;
    try {
      const res = editRule ? await api('PATCH', '/api/recurring/' + editRule.id, body) : await api('POST', '/api/recurring', body);
      $('#ruleDlg').close(); await refresh();
      toast(res.created ? `Saved. ${res.created} task${res.created === 1 ? '' : 's'} added to the board.` : `Saved. Next one appears before ${fmtDate(res.rule.nextDue)}.`);
    } catch (err) { showErr('#ruleError', err.message); }
    finally { b.disabled = false; }
  });
  $('#catForm').addEventListener('submit', async e => {
    e.preventDefault(); const name = $('#catName').value.trim(); if (!name) return;
    try { const { category } = await api('POST', '/api/categories', { name }); state.categories = [...state.categories, category].sort((a, b) => a.name.localeCompare(b.name)); $('#catName').value = ''; render(); toast('Category added'); }
    catch (err) { toast(err.message); }
  });
  async function delCat(c) {
    try { await api('DELETE', '/api/categories/' + c.id); await refresh(); toast(c.name + ' removed'); } catch (err) { toast(err.message); }
  }

  /* ---------- people ---------- */
  function openCount(id) { const mine = state.tasks.filter(t => t.assigneeId === id); return { open: mine.filter(t => t.status !== 'done').length, late: mine.filter(isLate).length }; }
  function personRow(u, tag) {
    const li = el('li');
    const wb = el('div', 'who-big'); wb.append(el('span', 'av lg', initials(u.name)));
    const txt = el('div'); txt.append(el('b', null, u.name), el('small', null, [u.title, 'ID: ' + u.username].filter(Boolean).join(' · '))); wb.append(txt); li.append(wb);
    if (!u.active) li.append(el('span', 'tag off', 'Deactivated')); else if (tag) li.append(el('span', 'tag', tag));
    const c = openCount(u.id); const nCl = state.clients.filter(x => x.active && (x.staffIds.includes(u.id) || x.managerId === u.id)).length;
    li.append(el('span', 'load', `${c.open} open${c.late ? ` · ${c.late} overdue` : ''} · ${nCl} client${nCl === 1 ? '' : 's'}`));
    if (u.id === state.me.id) {
      if (state.me.role === 'owner') { const m = el('div', 'mini'); m.append(btn('Edit', 'ghost', () => openPerson(u))); li.append(m); }
      return li;
    }
    const mini = el('div', 'mini'); const key = 'user:' + u.id;
    if (state.confirm === key) {
      mini.append(el('span', null, u.active ? 'Deactivate? They won\'t be able to sign in.' : 'Reactivate this account?'), btn(u.active ? 'Deactivate' : 'Reactivate', 'ghost danger', () => setActive(u, !u.active)), btn('Cancel', 'ghost', () => { state.confirm = null; renderPeople(); }));
      li.append(mini); return li;
    }
    if (state.me.role === 'owner' && u.role === 'staff' && u.active) {
      const mgrs = state.users.filter(x => x.role === 'partner' && x.active);
      if (mgrs.length > 1) { const s = el('select'); s.id = 'move-' + u.id; s.setAttribute('aria-label', 'Move ' + u.name + ' to another partner'); for (const m of mgrs) opt(s, m.id, 'Reports to ' + m.name); s.value = String(u.managerId); s.onchange = () => moveStaff(u, Number(s.value)); mini.append(s); }
    }
    mini.append(btn('Edit', 'ghost', () => openPerson(u)), btn('Reset password', 'ghost', () => openReset(u)),
      btn(u.active ? 'Deactivate' : 'Reactivate', 'ghost', () => { state.confirm = key; renderPeople(); }),
      btn('Delete', 'ghost danger', () => openDelete(u)));
    li.append(mini); return li;
  }
  function renderPeople() {
    const host = $('#peopleList'); host.replaceChildren();
    const teamGroup = (head, staff, emptyText, title) => {
      const g = el('section', 'group');
      if (title) { const gh = el('div', 'group-h'); gh.append(el('h2', null, title)); g.append(gh); }
      const ul = el('ul', 'plist');
      if (head) { const h = personRow(head, 'Partner'); h.classList.add('mgr'); ul.append(h); }
      staff.forEach(s => ul.append(personRow(s))); g.append(ul);
      if (!staff.length) g.append(el('p', 'empty-group', emptyText));
      host.append(g);
    };
    if (state.me.role === 'partner') {
      teamGroup(null, state.users.filter(u => u.role === 'staff' && u.managerId === state.me.id), 'No staff yet. Use “Add staff member” to create their login.', 'My staff');
      return;
    }
    teamGroup(null, state.users.filter(u => u.role === 'owner'), '', 'Owner');
    const partners = state.users.filter(u => u.role === 'partner');
    if (!partners.length) { const g = el('section', 'group'); g.append(el('p', 'empty-group', 'No partners yet. Use “Add person” to add a partner, then add the staff who report to them.')); host.append(g); }
    for (const p of partners) teamGroup(p, state.users.filter(u => u.role === 'staff' && u.managerId === p.id), 'No staff report to ' + p.name + ' yet.');
    const orphans = state.users.filter(u => u.role === 'staff' && !partners.some(p => p.id === u.managerId));
    if (orphans.length) teamGroup(null, orphans, '', 'Staff without a partner');
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
  let editPerson = null;
  function openPerson(u) {
    editPerson = u || null;
    $('#personForm').reset(); showErr('#personError');
    const owner = state.me.role === 'owner'; $('#roleRow').hidden = !owner || !!u;
    $('#uPassWrap').hidden = !!u; $('#uPass').required = !u; $('#personHelp').hidden = !!u;
    const sel = $('#uMgr'); sel.replaceChildren(); for (const m of state.users.filter(x => x.role === 'partner' && x.active)) opt(sel, m.id, m.name);
    if (u) {
      $('#uName').value = u.name; $('#uTitle').value = u.title; $('#uLogin').value = u.username;
      $('#personDlgTitle').textContent = 'Edit ' + ({ owner: 'my details', partner: 'partner', manager: 'manager', staff: 'staff member' }[u.role]);
      $('#personSave').textContent = 'Save changes';
    } else { $('#uRole').value = owner && !sel.options.length ? 'partner' : 'staff'; syncRole(); $('#uPass').value = tempPassword(); }
    $('#personDlg').showModal(); $('#uName').focus();
  }
  function syncRole() {
    if (editPerson) return;
    const role = state.me.role === 'owner' ? $('#uRole').value : 'staff';
    $('#uMgrWrap').hidden = role !== 'staff' || state.me.role !== 'owner';
    const t = { staff: 'Add staff member', manager: 'Add manager', partner: 'Add partner' }[role];
    $('#personDlgTitle').textContent = t; $('#personSave').textContent = t;
  }
  $('#uRole').addEventListener('change', syncRole);
  $('#newPersonBtn').onclick = () => openPerson(null);
  $('#personForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#personError');
    if (editPerson) {
      const b = $('#personSave'); b.disabled = true;
      try {
        const { user } = await api('PATCH', '/api/users/' + editPerson.id, { name: $('#uName').value.trim(), title: $('#uTitle').value.trim(), username: $('#uLogin').value.trim() });
        state.users = state.users.map(x => x.id === user.id ? user : x);
        if (user.id === state.me.id) { Object.assign(state.me, user); $('#meName').textContent = user.name; }
        $('#personDlg').close(); await refresh();
        toast(user.username !== editPerson.username ? `Saved. New login ID: ${user.username}` : 'Details saved');
      } catch (err) { showErr('#personError', err.message); }
      finally { b.disabled = false; }
      return;
    }
    const role = state.me.role === 'owner' ? $('#uRole').value : 'staff';
    if (role === 'staff' && state.me.role === 'owner' && !$('#uMgr').value) return showErr('#personError', 'Add a partner first, then add staff under them.');
    const body = { role, managerId: Number($('#uMgr').value) || undefined, name: $('#uName').value.trim(), title: $('#uTitle').value.trim(), username: $('#uLogin').value.trim(), password: $('#uPass').value };
    const b = $('#personSave'); b.disabled = true;
    try { const { user } = await api('POST', '/api/users', body); state.users.push(user); $('#personDlg').close(); render(); toast(`${user.name} added. Login ID: ${user.username}`); }
    catch (err) { showErr('#personError', err.message); }
    finally { b.disabled = false; }
  });
  /* delete employee */
  let delUser = null, delNeedsTransfer = false;
  function openDelete(u) {
    delUser = u; showErr('#delError');
    const open = state.tasks.filter(t => t.assigneeId === u.id && t.status !== 'done' && t.visibility !== 'personal').length;
    const rules = state.rules.filter(r => r.assigneeId === u.id).length;
    const cl = state.clients.filter(c => c.managerId === u.id || c.staffIds.includes(u.id)).length;
    const staffCount = state.users.filter(x => x.managerId === u.id).length;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    $('#delTitle').textContent = 'Delete ' + u.name;
    delNeedsTransfer = !!(open || rules || cl);
    const blocked = u.role === 'partner' && staffCount > 0;
    if (blocked) $('#delInfo').textContent = `${u.name} still has ${plural(staffCount, 'staff member')}. Move them to another partner (People tab) before deleting.`;
    else if (delNeedsTransfer) $('#delInfo').textContent = `${u.name} has ${plural(open, 'open task')}, ${plural(rules, 'recurring task')} and ${plural(cl, 'client')}. Choose who takes these over.`;
    else $('#delInfo').textContent = `${u.name} has no open tasks or clients.`;
    const sel = $('#delTo'); sel.replaceChildren(); opt(sel, '', 'Choose a person');
    const need = u.role === 'partner' ? 'partner' : null;
    const cands = state.users.filter(x => x.active && x.id !== u.id && x.role !== 'owner' && (!need || x.role === need) &&
      (state.me.role !== 'partner' || x.id === state.me.id || x.managerId === state.me.id));
    for (const x of cands) opt(sel, x.id, x.name + (x.role === 'partner' ? ' (partner)' : x.title ? ' · ' + x.title : ''));
    if (u.role === 'staff' && cands.some(x => x.id === u.managerId)) sel.value = String(u.managerId);
    $('#delToWrap').hidden = blocked || !delNeedsTransfer;
    $('#delSave').disabled = blocked;
    if (!blocked && delNeedsTransfer && !cands.length) { showErr('#delError', 'There is no one to hand their work to. Add another ' + (need || 'person') + ' first.'); $('#delSave').disabled = true; }
    $('#delDlg').showModal();
  }
  $('#delForm').addEventListener('submit', async e => {
    e.preventDefault(); showErr('#delError');
    const body = {};
    if (delNeedsTransfer) { body.transferTo = Number($('#delTo').value); if (!body.transferTo) return showErr('#delError', 'Choose who takes over their work.'); }
    const b = $('#delSave'); b.disabled = true;
    try {
      const r = await api('DELETE', '/api/users/' + delUser.id, body);
      $('#delDlg').close(); await refresh();
      toast(r.to ? `${delUser.name} deleted. Work handed to ${r.to}.` : `${delUser.name} deleted.`);
    } catch (err) { showErr('#delError', err.message); }
    finally { b.disabled = false; }
  });

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
