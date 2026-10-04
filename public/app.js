'use strict';
// Minimal single-page client. All server data is inserted with textContent (never as HTML markup),
// so user-supplied text cannot execute as markup or script.
const view = document.getElementById('view');
const nav = document.getElementById('nav');
let me = null;
let categories = [];

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 3500); }
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');

async function api(method, url, body) {
  const res = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) { const err = new Error((data && data.error) || 'Request failed'); err.details = data && data.details; err.status = res.status; throw err; }
  return data;
}
function errBox(e) { return el('div', { class: 'error' }, e.message + (e.details ? ': ' + e.details.join('; ') : '')); }
function field(label, input) { return el('div', {}, el('label', {}, label), input); }

const TABS = {
  customer: [['New complaint', newComplaint], ['My complaints', () => listView('My complaints')], ['Track by reference', trackView]],
  officer: [['My assigned complaints', () => listView('My assigned complaints')]],
  supervisor: [['All complaints', () => listView('All complaints', true)], ['Reports', reportsView]],
  admin: [['Users', usersView], ['Categories', categoriesView], ['Audit trail', auditView]],
};

function renderNav(active) {
  nav.replaceChildren();
  if (!me) return;
  (TABS[me.role] || []).forEach(([label, fn]) => nav.append(el('button', { class: label === active ? 'active' : '', onclick: () => { renderNav(label); fn(); } }, label)));
  nav.append(el('button', { onclick: showNotifications }, 'Notifications'));
  nav.append(el('span', { class: 'muted' }, `${me.full_name} (${me.role})`));
  nav.append(el('button', { onclick: logout }, 'Log out'));
}
function go(label) { renderNav(label); (TABS[me.role].find((t) => t[0] === label) || TABS[me.role][0])[1](); }

// ---- authentication ----
function authView() {
  nav.replaceChildren(); view.replaceChildren();
  const err = el('div');
  const email = el('input', { type: 'email', autocomplete: 'username' }), pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const login = el('div', { class: 'card' }, el('h2', {}, 'Log in'), err, field('E-mail', email), field('Password', pw),
    el('p', {}, el('button', { class: 'primary', onclick: async () => { try { me = await api('POST', '/auth/login', { email: email.value, password: pw.value }); start(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Log in')));
  const rerr = el('div');
  const rn = el('input', { autocomplete: 'name' }), re = el('input', { type: 'email' }), rp = el('input', { type: 'tel' }), rpw = el('input', { type: 'password', autocomplete: 'new-password' });
  const reg = el('div', { class: 'card' }, el('h2', {}, 'Register as a customer'), rerr, field('Full name', rn), field('E-mail', re), field('Phone (optional)', rp), field('Password (at least 8 characters)', rpw),
    el('p', {}, el('button', { onclick: async () => { try { await api('POST', '/auth/register', { full_name: rn.value, email: re.value, phone: rp.value, password: rpw.value }); rerr.replaceChildren(el('div', { class: 'muted' }, 'Account created. You can now log in.')); } catch (e) { rerr.replaceChildren(errBox(e)); } } }, 'Create account')));
  view.append(login, reg);
}
async function logout() { try { await api('POST', '/auth/logout'); } catch (e) { /* ignore */ } me = null; authView(); }

// ---- customer ----
function newComplaint() {
  view.replaceChildren();
  const err = el('div'), out = el('div');
  const cat = el('select', {}, categories.map((c) => el('option', { value: c.category_id }, `${c.category_name} (target ${c.resolution_hours} h)`)));
  const subject = el('input', { maxlength: 150 }), desc = el('textarea', { maxlength: 4000 });
  view.append(el('div', { class: 'card' }, el('h2', {}, 'Submit a complaint'), err, field('Category', cat), field('Subject', subject), field('Description', desc),
    el('p', {}, el('button', { class: 'primary', onclick: async () => {
      try { const r = await api('POST', '/complaints', { category_id: cat.value, subject: subject.value, description: desc.value }); err.replaceChildren();
        out.replaceChildren(el('div', { class: 'card' }, el('strong', {}, 'Complaint received. Your reference number is ' + r.reference_no), el('p', { class: 'muted' }, 'Target resolution date: ' + fmt(r.due_at))));
        subject.value = ''; desc.value = ''; } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Submit')), out));
}
function trackView() {
  view.replaceChildren();
  const err = el('div'), ref = el('input', { placeholder: 'CMP-2026-000123' });
  view.append(el('div', { class: 'card' }, el('h2', {}, 'Track a complaint'), err, field('Reference number', ref),
    el('p', {}, el('button', { class: 'primary', onclick: async () => { try { const c = await api('GET', '/complaints/ref/' + encodeURIComponent(ref.value.trim())); openDetail(c.complaint_id); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Track'))));
}

// ---- lists ----
async function listView(title, supervisor) {
  view.replaceChildren();
  const status = el('select', {}, el('option', { value: '' }, 'All statuses'), ['Submitted', 'Assigned', 'In Progress', 'Resolved', 'Closed'].map((s) => el('option', { value: s }, s)));
  const esc = el('input', { type: 'checkbox' });
  const box = el('div');
  async function load() {
    try {
      const rows = await api('GET', '/complaints?limit=100' + (status.value ? '&status=' + encodeURIComponent(status.value) : '') + (esc.checked ? '&escalated=1' : ''));
      const t = el('table', {}, el('tr', {}, ['Reference', 'Subject', 'Category', 'Status', 'Priority', 'Due', ''].map((h) => el('th', {}, h))),
        rows.map((r) => el('tr', { class: 'clickable', onclick: () => openDetail(r.complaint_id) },
          el('td', {}, r.reference_no), el('td', {}, r.subject), el('td', {}, r.category_name), el('td', {}, r.status), el('td', {}, r.priority), el('td', {}, fmt(r.due_at)),
          el('td', {}, r.is_escalated ? el('span', { class: 'tag escalated' }, 'Escalated') : ''))));
      box.replaceChildren(rows.length ? t : el('p', { class: 'muted' }, 'No complaints found.'));
    } catch (e) { box.replaceChildren(errBox(e)); }
  }
  status.addEventListener('change', load); esc.addEventListener('change', load);
  view.append(el('div', { class: 'card' }, el('h2', {}, title), el('div', { class: 'row' }, field('Status', status), supervisor ? el('div', {}, el('label', {}, 'Escalated only'), esc) : null), box));
  load();
}

// ---- detail ----
async function openDetail(id) {
  view.replaceChildren();
  let c; try { c = await api('GET', '/complaints/' + id); } catch (e) { view.append(errBox(e)); return; }
  const staff = me.role === 'officer' || me.role === 'supervisor';
  const err = el('div');
  const reload = () => openDetail(id);
  const card = el('div', { class: 'card' }, el('h2', {}, `${c.reference_no}: ${c.subject}`),
    el('p', {}, el('span', { class: 'tag' }, c.status), ' ', c.is_escalated ? el('span', { class: 'tag escalated' }, 'Escalated') : '', ' ', el('span', { class: 'muted' }, `${c.category_name} | priority ${c.priority} | due ${fmt(c.due_at)}`)),
    el('p', {}, c.description), err);
  const hist = el('ul', { class: 'history' }, c.history.map((h) => el('li', {}, el('strong', {}, h.update_type), ' ', el('span', { class: 'muted' }, fmt(h.created_at) + (h.visible_to_customer || me.role === 'customer' ? '' : ' (internal)')), el('div', {}, h.message))));
  card.append(el('h3', {}, 'History'), c.history.length ? hist : el('p', { class: 'muted' }, 'No updates yet.'));
  if (c.feedback) card.append(el('p', {}, `Customer feedback: ${c.feedback.rating}/5` + (c.feedback.comment ? ' - ' + c.feedback.comment : '')));
  view.append(card);

  if (c.status !== 'Closed') {
    const msg = el('textarea'); const internal = el('input', { type: 'checkbox' });
    view.append(el('div', { class: 'card' }, el('h3', {}, staff ? 'Reply or add a note' : 'Send a message'), msg,
      staff ? el('label', {}, internal, ' Internal note (not shown to the customer)') : null,
      el('p', {}, el('button', { onclick: async () => { try { await api('POST', `/complaints/${id}/messages`, { message: msg.value, internal: internal.checked }); reload(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Send'))));
  }
  if (staff) {
    const next = { Assigned: 'In Progress', 'In Progress': 'Resolved', Resolved: me.role === 'supervisor' ? 'Closed' : null }[c.status];
    if (next) { const note = el('textarea', { placeholder: next === 'Resolved' ? 'Resolution note (required)' : 'Note' });
      view.append(el('div', { class: 'card' }, el('h3', {}, `Move to "${next}"`), note, el('p', {}, el('button', { class: 'primary', onclick: async () => { try { await api('POST', `/complaints/${id}/status`, { status: next, note: note.value }); reload(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Update status')))); }
  }
  if (me.role === 'supervisor' && !['Resolved', 'Closed'].includes(c.status)) {
    const o = await api('GET', '/officers'); const sel = el('select', {}, el('option', { value: '' }, o.suggested ? `Suggested: ${o.suggested.full_name}` : 'Suggested officer'), o.officers.map((x) => el('option', { value: x.user_id }, `${x.full_name} (${x.open_count} open)`)));
    view.append(el('div', { class: 'card' }, el('h3', {}, 'Assign to an officer'), sel, el('p', {}, el('button', { onclick: async () => { try { await api('POST', `/complaints/${id}/assign`, sel.value ? { officer_id: Number(sel.value) } : {}); reload(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Assign'))));
  }
  if (me.role === 'customer' && c.status === 'Resolved') {
    const rating = el('select', {}, [5, 4, 3, 2, 1].map((n) => el('option', { value: n }, n + ' / 5'))); const comment = el('textarea', { maxlength: 500 });
    view.append(el('div', { class: 'card' }, el('h3', {}, 'How did we do?'), field('Rating', rating), field('Comment (optional)', comment),
      el('p', {}, el('button', { class: 'primary', onclick: async () => { try { await api('POST', `/complaints/${id}/feedback`, { rating: Number(rating.value), comment: comment.value }); reload(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Submit feedback'))));
  }
}

// ---- supervisor reports ----
async function reportsView() {
  view.replaceChildren();
  try {
    const r = await api('GET', '/reports/summary');
    const tbl = (head, rows) => el('table', {}, el('tr', {}, head.map((h) => el('th', {}, h))), rows.map((row) => el('tr', {}, row.map((x) => el('td', {}, x == null ? '-' : x)))));
    view.append(el('div', { class: 'card' }, el('h2', {}, 'Complaints by status'), tbl(['Status', 'Total'], r.by_status.map((x) => [x.status, x.total]))),
      el('div', { class: 'card' }, el('h2', {}, 'Complaints by category'), tbl(['Category', 'Total', 'Escalated', 'Avg resolution (h)'], r.by_category.map((x) => [x.category_name, x.total_complaints, x.escalated, x.avg_resolution_hours]))),
      el('div', { class: 'card' }, el('h2', {}, 'Customer rating by category'), tbl(['Category', 'Responses', 'Average rating'], r.rating_by_category.map((x) => [x.category_name, x.responses, x.avg_rating]))),
      el('div', { class: 'card' }, el('h2', {}, 'Officer workload (open complaints)'), tbl(['Officer', 'Open'], r.officer_workload.map((x) => [x.full_name, x.open_complaints]))));
  } catch (e) { view.append(errBox(e)); }
}

// ---- administrator ----
async function usersView() {
  view.replaceChildren(); const err = el('div');
  const f = { n: el('input'), e: el('input', { type: 'email' }), p: el('input', { type: 'password' }), r: el('select', {}, ['customer', 'officer', 'supervisor', 'admin'].map((x) => el('option', { value: x }, x))) };
  const box = el('div');
  async function load() {
    try { const users = await api('GET', '/admin/users');
      box.replaceChildren(el('table', {}, el('tr', {}, ['ID', 'Name', 'E-mail', 'Role', 'Active', ''].map((h) => el('th', {}, h))),
        users.map((u) => el('tr', {}, el('td', {}, u.user_id), el('td', {}, u.full_name), el('td', {}, u.email), el('td', {}, u.role), el('td', {}, u.is_active ? 'Yes' : 'No'),
          el('td', {}, el('button', { onclick: async () => { try { await api('PATCH', '/admin/users/' + u.user_id, { is_active: !u.is_active }); load(); } catch (e) { err.replaceChildren(errBox(e)); } } }, u.is_active ? 'Deactivate' : 'Activate')))))); }
    catch (e) { box.replaceChildren(errBox(e)); }
  }
  view.append(el('div', { class: 'card' }, el('h2', {}, 'Create a user'), err, el('div', { class: 'row' }, field('Full name', f.n), field('E-mail', f.e), field('Password', f.p), field('Role', f.r)),
    el('p', {}, el('button', { class: 'primary', onclick: async () => { try { await api('POST', '/admin/users', { full_name: f.n.value, email: f.e.value, password: f.p.value, role: f.r.value }); err.replaceChildren(); f.n.value = f.e.value = f.p.value = ''; load(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Create'))),
    el('div', { class: 'card' }, el('h2', {}, 'Users'), box));
  load();
}
async function categoriesView() {
  view.replaceChildren(); const err = el('div');
  const f = { n: el('input'), d: el('input'), p: el('select', {}, ['Low', 'Medium', 'High'].map((x) => el('option', { value: x }, x))), h: el('input', { type: 'number', min: 1 }) };
  const box = el('div');
  async function load() {
    try { categories = await api('GET', '/categories');
      box.replaceChildren(el('table', {}, el('tr', {}, ['Category', 'Priority', 'Target (hours)', ''].map((h) => el('th', {}, h))),
        categories.map((c) => { const hrs = el('input', { type: 'number', min: 1, value: c.resolution_hours });
          return el('tr', {}, el('td', {}, c.category_name), el('td', {}, c.default_priority), el('td', {}, hrs),
            el('td', {}, el('button', { onclick: async () => { try { await api('PATCH', '/admin/categories/' + c.category_id, { resolution_hours: Number(hrs.value) }); toast('Saved'); load(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Save'))); }))); }
    catch (e) { box.replaceChildren(errBox(e)); }
  }
  view.append(el('div', { class: 'card' }, el('h2', {}, 'Add a category'), err, el('div', { class: 'row' }, field('Name', f.n), field('Description', f.d), field('Default priority', f.p), field('Target (hours)', f.h)),
    el('p', {}, el('button', { class: 'primary', onclick: async () => { try { await api('POST', '/admin/categories', { category_name: f.n.value, description: f.d.value, default_priority: f.p.value, resolution_hours: Number(f.h.value) }); err.replaceChildren(); f.n.value = f.d.value = f.h.value = ''; load(); } catch (e) { err.replaceChildren(errBox(e)); } } }, 'Add'))),
    el('div', { class: 'card' }, el('h2', {}, 'Categories and resolution targets'), box));
  load();
}
async function auditView() {
  view.replaceChildren();
  try { const rows = await api('GET', '/admin/audit?limit=200');
    view.append(el('div', { class: 'card' }, el('h2', {}, 'Audit trail (most recent 200)'), el('table', {}, el('tr', {}, ['When', 'User', 'Action', 'Entity', 'IP'].map((h) => el('th', {}, h))),
      rows.map((r) => el('tr', {}, el('td', {}, fmt(r.created_at)), el('td', {}, r.user_id == null ? 'system' : r.user_id), el('td', {}, r.action), el('td', {}, r.entity_type ? `${r.entity_type} ${r.entity_id ?? ''}` : ''), el('td', {}, r.ip_address || '')))))); }
  catch (e) { view.append(errBox(e)); }
}
async function showNotifications() {
  view.replaceChildren();
  try { const rows = await api('GET', '/notifications');
    view.append(el('div', { class: 'card' }, el('h2', {}, 'Notifications'), rows.length ? el('table', {}, el('tr', {}, ['Subject', 'Message', 'Delivery'].map((h) => el('th', {}, h))), rows.map((r) => el('tr', {}, el('td', {}, r.subject), el('td', {}, r.message), el('td', {}, r.delivery_status)))) : el('p', { class: 'muted' }, 'No notifications.'))); }
  catch (e) { view.append(errBox(e)); }
}

async function start() {
  try { categories = await api('GET', '/categories'); } catch (e) { categories = []; }
  go(TABS[me.role][0][0]);
}
(async function init() { try { me = await api('GET', '/auth/me'); start(); } catch (e) { authView(); } })();
