const crypto = require('crypto');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const { HttpError } = require('../errors');
const { authorized } = require('../middleware/rbac');
const v = require('../middleware/validate');
const audit = require('./auditService');
const { notify } = require('./notificationService');

// Table 3.2: permitted transitions
const ALLOWED = { Assigned: ['In Progress'], 'In Progress': ['Resolved'], Resolved: ['Closed'] };
const pad = (n, w) => String(n).padStart(w, '0');

async function getRaw(id, conn = pool) {
  const [[c]] = await conn.execute('SELECT * FROM complaints WHERE complaint_id = ?', [id]);
  return c || null;
}

// Algorithm 3.1: SubmitComplaint
async function submit(user, body, ip) {
  const form = v.validateComplaint(body);
  const [[category]] = await pool.execute('SELECT * FROM categories WHERE category_id = ?', [form.category_id]);
  if (!category) throw new HttpError(400, 'Validation failed', ['Unknown category']);
  const now = new Date();
  const due = new Date(now.getTime() + category.resolution_hours * 3600 * 1000);
  const result = await withTransaction(async (conn) => {
    const temp = 'TMP-' + crypto.randomBytes(8).toString('hex'); // 20 chars
    const [ins] = await conn.execute(
      `INSERT INTO complaints (reference_no, customer_id, category_id, subject, description, priority, status, submitted_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Submitted', ?, ?)`,
      [temp, user.userId, category.category_id, form.subject, form.description, category.default_priority, now, due]);
    const id = ins.insertId;
    const ref = `CMP-${now.getUTCFullYear()}-${pad(id, 6)}`;
    await conn.execute('UPDATE complaints SET reference_no = ? WHERE complaint_id = ?', [ref, id]);
    await audit.log(conn, { userId: user.userId, action: 'COMPLAINT_SUBMITTED', entityType: 'complaint', entityId: id, ip });
    return { complaint_id: id, reference_no: ref, due_at: due };
  });
  await notify(user.userId, result.complaint_id, `Complaint received: ${result.reference_no}`,
    `Your complaint "${form.subject}" has been received. Reference number: ${result.reference_no}. Target resolution date: ${due.toISOString()}.`);
  return result;
}

const SELECT_LIST = `SELECT c.complaint_id, c.reference_no, c.subject, c.priority, c.status, c.is_escalated, c.submitted_at, c.due_at,
  c.customer_id, c.assigned_officer_id, cat.category_name FROM complaints c JOIN categories cat ON cat.category_id = c.category_id`;

async function list(user, { status, page = 1, limit = 25, escalated } = {}) {
  const where = []; const params = [];
  if (user.role === 'customer') { where.push('c.customer_id = ?'); params.push(user.userId); }
  else if (user.role === 'officer') { where.push('c.assigned_officer_id = ?'); params.push(user.userId); }
  else if (user.role !== 'supervisor') throw new HttpError(403, 'Forbidden');
  if (status) { if (!v.STATUSES.includes(status)) throw new HttpError(400, 'status is not valid'); where.push('c.status = ?'); params.push(status); }
  if (escalated === '1' || escalated === 'true') where.push('c.is_escalated = 1');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
  const sql = `${SELECT_LIST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.due_at ASC, c.complaint_id ASC LIMIT ${lim} OFFSET ${off}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function detailFromRow(user, c) {
  const permission = user.role === 'customer' ? 'view_own_complaints' : (user.role === 'supervisor' ? 'view_all_complaints' : 'view_assigned_complaints');
  if (!authorized(user, permission, c)) throw new HttpError(404, 'Complaint not found'); // 404 so existence is not revealed
  const [[cat]] = await pool.execute('SELECT category_name FROM categories WHERE category_id = ?', [c.category_id]);
  const visibility = user.role === 'customer' ? 'AND visible_to_customer = 1' : '';
  const [history] = await pool.execute(
    `SELECT update_id, author_id, update_type, message, visible_to_customer, created_at FROM complaint_updates WHERE complaint_id = ? ${visibility} ORDER BY created_at, update_id`, [c.complaint_id]);
  const [[fb]] = await pool.execute('SELECT rating, comment, submitted_at FROM feedback WHERE complaint_id = ?', [c.complaint_id]);
  return { ...c, category_name: cat.category_name, history, feedback: fb || null };
}

async function getDetail(user, id) {
  const c = await getRaw(id);
  if (!c) throw new HttpError(404, 'Complaint not found');
  return detailFromRow(user, c);
}

async function getByReference(user, ref) {
  if (typeof ref !== 'string' || !/^CMP-\d{4}-\d{6,}$/.test(ref)) throw new HttpError(400, 'Invalid reference number');
  const [[c]] = await pool.execute('SELECT * FROM complaints WHERE reference_no = ?', [ref]);
  if (!c) throw new HttpError(404, 'Complaint not found');
  return detailFromRow(user, c);
}

// Algorithm 3.3: UpdateStatus
async function updateStatus(user, id, body, ip) {
  const { status: next, note } = v.validateStatusChange(body);
  const c = await getRaw(id);
  if (!c) throw new HttpError(404, 'Complaint not found');
  if (!authorized(user, 'update_complaint', c)) {
    await audit.log(null, { userId: user.userId, action: 'ACCESS_DENIED', entityType: 'complaint', entityId: id, ip });
    throw new HttpError(403, 'Forbidden');
  }
  if (!(ALLOWED[c.status] || []).includes(next)) throw new HttpError(409, `Transition from ${c.status} to ${next} is not permitted`);
  // Manual closure is reserved for supervisors; normally closure follows feedback or the scheduled job (Table 3.2)
  if (next === 'Closed' && user.role !== 'supervisor') throw new HttpError(403, 'Only a supervisor can close a complaint manually');
  if (next === 'Resolved' && note.length < config.limits.minNote) throw new HttpError(400, 'Validation failed', [`A resolution note of at least ${config.limits.minNote} characters is required`]);
  const now = new Date();
  await withTransaction(async (conn) => {
    const [r] = await conn.execute(
      `UPDATE complaints SET status = ?, resolved_at = IF(? = 'Resolved', ?, resolved_at), closed_at = IF(? = 'Closed', ?, closed_at) WHERE complaint_id = ? AND status = ?`,
      [next, next, now, next, now, id, c.status]);
    if (!r.affectedRows) throw new HttpError(409, 'The complaint was changed by someone else; please reload');
    await conn.execute('INSERT INTO complaint_updates (complaint_id, author_id, update_type, message, visible_to_customer) VALUES (?, ?, ?, ?, 1)',
      [id, user.userId, next === 'Resolved' ? 'Resolution' : 'Status Change', note || `Status changed to ${next}`]);
    await audit.log(conn, { userId: user.userId, action: 'STATUS_' + next.toUpperCase().replace(' ', '_'), entityType: 'complaint', entityId: id, ip });
  });
  if (next === 'Resolved') await notify(c.customer_id, id, `Complaint resolved: ${c.reference_no}`, `Your complaint ${c.reference_no} has been resolved. Please give us your feedback.`);
  return getDetail(user, id);
}

// Messages (FR-06) and internal notes
async function addMessage(user, id, body, ip) {
  const { message, internal } = v.validateMessage(body);
  const c = await getRaw(id);
  if (!c) throw new HttpError(404, 'Complaint not found');
  if (!authorized(user, 'message_complaint', c)) throw new HttpError(c && user.role === 'customer' ? 404 : 403, user.role === 'customer' ? 'Complaint not found' : 'Forbidden');
  if (c.status === 'Closed') throw new HttpError(409, 'The complaint is closed');
  if (internal && user.role === 'customer') throw new HttpError(403, 'Forbidden');
  const type = user.role === 'customer' ? 'Customer Message' : (internal ? 'Note' : 'Officer Message');
  await withTransaction(async (conn) => {
    await conn.execute('INSERT INTO complaint_updates (complaint_id, author_id, update_type, message, visible_to_customer) VALUES (?, ?, ?, ?, ?)',
      [id, user.userId, type, message, internal ? 0 : 1]);
    await audit.log(conn, { userId: user.userId, action: 'MESSAGE_ADDED', entityType: 'complaint', entityId: id, details: { type }, ip });
  });
  if (user.role === 'customer' && c.assigned_officer_id) await notify(c.assigned_officer_id, id, `New message on ${c.reference_no}`, 'The customer has sent a new message.');
  if (user.role !== 'customer' && !internal) await notify(c.customer_id, id, `Update on ${c.reference_no}`, 'There is a new message about your complaint.');
  return getDetail(user, id);
}

// FR-11: feedback closes a resolved complaint
async function submitFeedback(user, id, body, ip) {
  const { rating, comment } = v.validateFeedback(body);
  const c = await getRaw(id);
  if (!c || !authorized(user, 'submit_feedback', c)) throw new HttpError(404, 'Complaint not found');
  if (c.status !== 'Resolved') throw new HttpError(409, 'Feedback can only be given for a resolved complaint');
  const now = new Date();
  try {
    await withTransaction(async (conn) => {
      await conn.execute('INSERT INTO feedback (complaint_id, rating, comment) VALUES (?, ?, ?)', [id, rating, comment]);
      await conn.execute("UPDATE complaints SET status = 'Closed', closed_at = ? WHERE complaint_id = ?", [now, id]);
      await audit.log(conn, { userId: user.userId, action: 'FEEDBACK_SUBMITTED', entityType: 'complaint', entityId: id, details: { rating }, ip });
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Feedback has already been given');
    throw e;
  }
  return getDetail(user, id);
}

module.exports = { submit, list, getDetail, getByReference, updateStatus, addMessage, submitFeedback, getRaw, ALLOWED };
