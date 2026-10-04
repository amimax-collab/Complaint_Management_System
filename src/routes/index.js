const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const v = require('../middleware/validate');
const { HttpError } = require('../errors');
const { pool } = require('../db');
const users = require('../services/userService');
const complaints = require('../services/complaintService');
const assignment = require('../services/assignmentService');
const reports = require('../services/reportService');
const notifications = require('../services/notificationService');
const audit = require('../services/auditService');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sessionUser = (u) => ({ userId: u.user_id, role: u.role, name: u.full_name });
const router = express.Router();

// ---- authentication ----
router.post('/auth/register', wrap(async (req, res) => { res.status(201).json(await users.register(req.body, req.ip)); }));
router.post('/auth/login', wrap(async (req, res) => {
  const u = await users.login(req.body && req.body.email, req.body && req.body.password, req.ip);
  await new Promise((ok, no) => req.session.regenerate((e) => (e ? no(e) : ok())));
  req.session.user = sessionUser(u);
  res.json(u);
}));
router.post('/auth/logout', requireAuth, wrap(async (req, res) => {
  await audit.log(null, { userId: req.session.user.userId, action: 'LOGOUT', entityType: 'user', entityId: req.session.user.userId, ip: req.ip });
  await new Promise((ok) => req.session.destroy(() => ok()));
  res.clearCookie('ccms.sid'); res.json({ ok: true });
}));
router.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const [[u]] = await pool.execute('SELECT user_id, full_name, email, role FROM users WHERE user_id = ?', [req.session.user.userId]);
  res.json(u);
}));

// ---- reference data ----
router.get('/categories', requireAuth, wrap(async (_req, res) => {
  const [rows] = await pool.execute('SELECT category_id, category_name, description, default_priority, resolution_hours FROM categories ORDER BY category_name');
  res.json(rows);
}));

// ---- complaints ----
router.post('/complaints', requirePermission('submit_complaint'), wrap(async (req, res) => { res.status(201).json(await complaints.submit(req.session.user, req.body, req.ip)); }));
router.get('/complaints', requireAuth, wrap(async (req, res) => { res.json(await complaints.list(req.session.user, req.query)); }));
router.get('/complaints/ref/:ref', requireAuth, wrap(async (req, res) => { res.json(await complaints.getByReference(req.session.user, req.params.ref)); }));
router.get('/complaints/:id', requireAuth, wrap(async (req, res) => { res.json(await complaints.getDetail(req.session.user, v.parseId(req.params.id))); }));
router.post('/complaints/:id/assign', requirePermission('assign_complaint'), wrap(async (req, res) => {
  const officerId = req.body && req.body.officer_id != null ? v.parseId(String(req.body.officer_id)) : null;
  res.json(await assignment.assign(req.session.user, v.parseId(req.params.id), officerId, req.ip));
}));
router.post('/complaints/:id/status', requireAuth, wrap(async (req, res) => { res.json(await complaints.updateStatus(req.session.user, v.parseId(req.params.id), req.body, req.ip)); }));
router.post('/complaints/:id/messages', requireAuth, wrap(async (req, res) => { res.status(201).json(await complaints.addMessage(req.session.user, v.parseId(req.params.id), req.body, req.ip)); }));
router.post('/complaints/:id/feedback', requirePermission('submit_feedback'), wrap(async (req, res) => { res.status(201).json(await complaints.submitFeedback(req.session.user, v.parseId(req.params.id), req.body, req.ip)); }));

// ---- supervisor ----
router.get('/officers', requirePermission('assign_complaint'), wrap(async (_req, res) => {
  res.json({ officers: await assignment.officersWithWorkload(), suggested: await assignment.suggestOfficer() });
}));
router.get('/reports/summary', requirePermission('view_reports'), wrap(async (req, res) => {
  const { from, to } = v.parseDateRange(req.query); res.json(await reports.summary(from, to));
}));

// ---- notifications ----
router.get('/notifications', requireAuth, wrap(async (req, res) => { res.json(await notifications.listForUser(req.session.user.userId, req.query.limit)); }));

// ---- administrator ----
router.get('/admin/users', requirePermission('manage_users'), wrap(async (req, res) => { res.json(await users.list({ role: v.ROLES.includes(req.query.role) ? req.query.role : undefined })); }));
router.post('/admin/users', requirePermission('manage_users'), wrap(async (req, res) => { res.status(201).json(await users.adminCreate(req.body, req.session.user.userId, req.ip)); }));
router.patch('/admin/users/:id', requirePermission('manage_users'), wrap(async (req, res) => { res.json(await users.patch(v.parseId(req.params.id), req.body, req.session.user, req.ip)); }));
router.post('/admin/categories', requirePermission('manage_categories'), wrap(async (req, res) => {
  const c = v.validateCategory(req.body);
  try {
    const [r] = await pool.execute('INSERT INTO categories (category_name, description, default_priority, resolution_hours) VALUES (?, ?, ?, ?)', [c.category_name, c.description || null, c.default_priority, c.resolution_hours]);
    await audit.log(null, { userId: req.session.user.userId, action: 'CATEGORY_CREATED', entityType: 'category', entityId: r.insertId, details: c, ip: req.ip });
    res.status(201).json({ category_id: r.insertId, ...c });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A category with this name already exists'); throw e; }
}));
router.patch('/admin/categories/:id', requirePermission('manage_categories'), wrap(async (req, res) => {
  const id = v.parseId(req.params.id); const c = v.validateCategory(req.body, true);
  if (!Object.keys(c).length) throw new HttpError(400, 'Validation failed', ['nothing to update']);
  const sets = Object.keys(c).map((k) => `${k} = ?`).join(', ');
  const [r] = await pool.execute(`UPDATE categories SET ${sets} WHERE category_id = ?`, [...Object.values(c), id]);
  if (!r.affectedRows) throw new HttpError(404, 'Category not found');
  await audit.log(null, { userId: req.session.user.userId, action: 'CATEGORY_UPDATED', entityType: 'category', entityId: id, details: c, ip: req.ip });
  res.json({ category_id: id, ...c });
}));
router.get('/admin/audit', requirePermission('view_audit'), wrap(async (req, res) => {
  const { from, to } = req.query.from || req.query.to ? v.parseDateRange(req.query) : {};
  res.json(await audit.search({
    userId: req.query.user_id ? v.parseId(String(req.query.user_id)) : undefined, entityType: req.query.entity_type ? String(req.query.entity_type).slice(0, 30) : undefined,
    entityId: req.query.entity_id ? v.parseId(String(req.query.entity_id)) : undefined, action: req.query.action ? String(req.query.action).slice(0, 50) : undefined, from, to, limit: req.query.limit }));
}));

module.exports = router;
