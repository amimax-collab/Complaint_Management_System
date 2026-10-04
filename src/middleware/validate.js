const { limits } = require('../config');
const { HttpError } = require('../errors');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const PRIORITIES = ['Low', 'Medium', 'High'];
const ROLES = ['customer', 'officer', 'supervisor', 'admin'];
const STATUSES = ['Submitted', 'Assigned', 'In Progress', 'Resolved', 'Closed'];

const s = (v) => (typeof v === 'string' ? v.trim() : '');
const isInt = (v) => Number.isInteger(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
const toInt = (v) => (typeof v === 'string' ? Number(v) : v);
const lenOk = (str, min, max) => str.length >= min && str.length <= max;

function fail(errors) { if (errors.length) throw new HttpError(400, 'Validation failed', errors); }

function validatePassword(pw, errors) {
  if (typeof pw !== 'string' || pw.length < limits.minPassword || pw.length > limits.maxPassword)
    errors.push(`password must be ${limits.minPassword}-${limits.maxPassword} characters`);
}

function validateRegistration(b = {}) {
  const errors = [];
  const v = { full_name: s(b.full_name), email: s(b.email).toLowerCase(), phone: s(b.phone) || null };
  if (!lenOk(v.full_name, 2, 100)) errors.push('full_name must be 2-100 characters');
  if (!EMAIL_RE.test(v.email) || v.email.length > 120) errors.push('email is not valid');
  if (v.phone && !/^[0-9+()\-\s]{7,20}$/.test(v.phone)) errors.push('phone is not valid');
  validatePassword(b.password, errors);
  fail(errors);
  return { ...v, password: b.password };
}

function validateComplaint(b = {}) {
  const errors = [];
  const v = { category_id: toInt(b.category_id), subject: s(b.subject), description: s(b.description) };
  if (!isInt(b.category_id) || v.category_id < 1) errors.push('category_id is required');
  if (!lenOk(v.subject, limits.minSubject, limits.maxSubject)) errors.push(`subject must be ${limits.minSubject}-${limits.maxSubject} characters`);
  if (!lenOk(v.description, limits.minDescription, limits.maxDescription)) errors.push(`description must be ${limits.minDescription}-${limits.maxDescription} characters`);
  fail(errors);
  return v;
}

function validateStatusChange(b = {}) {
  const errors = [];
  const v = { status: s(b.status), note: s(b.note) };
  if (!STATUSES.includes(v.status)) errors.push('status is not valid');
  if (v.note.length > 4000) errors.push('note is too long');
  fail(errors);
  return v;
}

function validateMessage(b = {}) {
  const errors = [];
  const v = { message: s(b.message), internal: b.internal === true };
  if (!lenOk(v.message, 2, 4000)) errors.push('message must be 2-4000 characters');
  fail(errors);
  return v;
}

function validateFeedback(b = {}) {
  const errors = [];
  const rating = toInt(b.rating);
  const v = { rating, comment: s(b.comment) || null };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push('rating must be a whole number from 1 to 5');
  if (v.comment && v.comment.length > 500) errors.push('comment must be at most 500 characters');
  fail(errors);
  return v;
}

function validateUserCreate(b = {}) {
  const base = validateRegistration(b);
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Validation failed', ['role is not valid']);
  return { ...base, role: b.role };
}

function validateUserPatch(b = {}) {
  const errors = []; const v = {};
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) errors.push('role is not valid'); else v.role = b.role; }
  if (b.is_active !== undefined) { if (typeof b.is_active !== 'boolean') errors.push('is_active must be true or false'); else v.is_active = b.is_active ? 1 : 0; }
  if (b.full_name !== undefined) { const n = s(b.full_name); if (!lenOk(n, 2, 100)) errors.push('full_name must be 2-100 characters'); else v.full_name = n; }
  if (!Object.keys(v).length && !errors.length) errors.push('nothing to update');
  fail(errors);
  return v;
}

function validateCategory(b = {}, partial = false) {
  const errors = []; const v = {};
  if (!partial || b.category_name !== undefined) { const n = s(b.category_name); if (!lenOk(n, 2, 80)) errors.push('category_name must be 2-80 characters'); else v.category_name = n; }
  if (b.description !== undefined) { const d = s(b.description); if (d.length > 255) errors.push('description must be at most 255 characters'); else v.description = d; }
  if (!partial || b.default_priority !== undefined) { if (!PRIORITIES.includes(b.default_priority)) errors.push('default_priority is not valid'); else v.default_priority = b.default_priority; }
  if (!partial || b.resolution_hours !== undefined) { const h = toInt(b.resolution_hours); if (!Number.isInteger(h) || h < 1 || h > 24 * 365) errors.push('resolution_hours must be a whole number from 1 to 8760'); else v.resolution_hours = h; }
  fail(errors);
  return v;
}

function parseId(v) {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
}

function parseDateRange(q = {}) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = q.from || '1970-01-01'; const to = q.to || '2999-12-31';
  if (!re.test(from) || !re.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) throw new HttpError(400, 'from and to must be dates in YYYY-MM-DD format');
  return { from: `${from} 00:00:00`, to: `${to} 23:59:59` };
}

module.exports = { validateRegistration, validateComplaint, validateStatusChange, validateMessage, validateFeedback,
  validateUserCreate, validateUserPatch, validateCategory, parseId, parseDateRange, validatePassword, STATUSES, ROLES };
