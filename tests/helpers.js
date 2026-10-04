const request = require('supertest');
const argon2 = require('argon2');
const config = require('../src/config');
const { makePool } = require('../src/db');

const admin = makePool(config.db.adminUser, config.db.adminPassword);
const PASSWORD = 'Password123!';
let hash;

async function resetDb() {
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['audit_log', 'notifications', 'feedback', 'complaint_updates', 'complaints', 'categories', 'users']) await admin.query(`TRUNCATE TABLE ${t}`);
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');
}

async function seedBasic() {
  hash = hash || (await argon2.hash(PASSWORD));
  const rows = [['Admin One', 'admin@t.org', 'admin'], ['Supervisor One', 'sup@t.org', 'supervisor'], ['Officer One', 'off1@t.org', 'officer'],
    ['Officer Two', 'off2@t.org', 'officer'], ['Customer One', 'cust1@t.org', 'customer'], ['Customer Two', 'cust2@t.org', 'customer']];
  await admin.query('INSERT INTO users (full_name, email, password_hash, role) VALUES ?', [rows.map(([n, e, r]) => [n, e, hash, r])]);
  await admin.query("INSERT INTO categories (category_name, description, default_priority, resolution_hours) VALUES ('Billing', 'Billing issues', 'High', 48), ('Facilities', 'Premises', 'Low', 168)");
  const [u] = await admin.query('SELECT user_id, email FROM users');
  const id = Object.fromEntries(u.map((x) => [x.email.split('@')[0], x.user_id]));
  const [c] = await admin.query('SELECT category_id, category_name FROM categories');
  return { ids: id, billing: c.find((x) => x.category_name === 'Billing').category_id, facilities: c.find((x) => x.category_name === 'Facilities').category_id };
}

async function loginAs(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return agent;
}

const validComplaint = (categoryId, extra = {}) => ({ category_id: categoryId, subject: 'Charged twice for one purchase', description: 'I was charged twice for the same purchase on Monday and need a refund.', ...extra });

async function insertComplaint(fields) {
  const now = new Date();
  const d = { reference_no: 'CMP-2026-' + String(Math.floor(Math.random() * 900000) + 100000), customer_id: null, category_id: null, assigned_officer_id: null,
    subject: 'Seeded subject', description: 'Seeded description for tests.', priority: 'Medium', status: 'Submitted', is_escalated: 0,
    submitted_at: now, due_at: new Date(now.getTime() + 86400000), escalated_at: null, resolved_at: null, closed_at: null, ...fields };
  const [r] = await admin.query('INSERT INTO complaints SET ?', [d]);
  return r.insertId;
}

module.exports = { admin, resetDb, seedBasic, loginAs, validComplaint, insertComplaint, PASSWORD, request };
