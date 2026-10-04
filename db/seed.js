// Seeds simulated data (Section 3.6.4). Uses the privileged account because it clears tables first.
// Usage: node db/seed.js [customers] [complaints]   (defaults 500 and 3000)
require('dotenv').config({ quiet: true });
const argon2 = require('argon2');
const config = require('../src/config');
const { makePool } = require('../src/db');

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FIRST = ['Amina', 'Chinedu', 'Ngozi', 'Emeka', 'Fatima', 'Tunde', 'Zainab', 'Ibrahim', 'Blessing', 'Samuel', 'Hauwa', 'Obinna', 'Adaeze', 'Yusuf', 'Funke', 'Kelechi', 'Halima', 'Segun', 'Chioma', 'Musa'];
const LAST = ['Okafor', 'Bello', 'Adeyemi', 'Eze', 'Musa', 'Ogunleye', 'Abubakar', 'Nwosu', 'Lawal', 'Ibe', 'Garba', 'Oyelaran', 'Udo', 'Danjuma', 'Okeke', 'Balogun'];
const CATEGORIES = [
  ['Billing and Payments', 'Incorrect charges, refunds, payment problems', 'High', 48], ['Service Delivery', 'Late, incomplete or poor service', 'Medium', 72],
  ['Staff Conduct', 'Behaviour of staff towards customers', 'High', 48], ['Product Quality', 'Faulty or substandard products', 'Medium', 96],
  ['Account Access', 'Login, registration and account problems', 'Medium', 24], ['Information and Communication', 'Missing or unclear information', 'Low', 120],
  ['Facilities', 'Premises, equipment and environment', 'Low', 168], ['Other', 'Complaints that fit no other category', 'Low', 120]];
const SUBJECTS = ['Charged twice for one transaction', 'Service not delivered on the agreed date', 'Rude response from staff member', 'Item received was damaged', 'Unable to access my account', 'No reply to my earlier enquiry', 'Equipment out of order for several days', 'Incorrect amount on my statement'];

async function main() {
  const nCust = parseInt(process.argv[2] || '500', 10), nComp = parseInt(process.argv[3] || '3000', 10);
  const r = rng(20261003);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const pool = makePool(config.db.adminUser, config.db.adminPassword);
  const t0 = Date.now();
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['audit_log', 'notifications', 'feedback', 'complaint_updates', 'complaints', 'categories', 'users']) await pool.query(`TRUNCATE TABLE ${t}`);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  const hash = await argon2.hash('Password123!'); // one shared hash for all simulated accounts
  const users = [['System Administrator', 'admin@example.org', 'admin']];
  for (let i = 1; i <= 3; i++) users.push([`Supervisor ${i}`, `supervisor${i}@example.org`, 'supervisor']);
  for (let i = 1; i <= 10; i++) users.push([`Officer ${i}`, `officer${i}@example.org`, 'officer']);
  for (let i = 1; i <= nCust; i++) users.push([`${pick(FIRST)} ${pick(LAST)}`, `customer${i}@example.org`, 'customer']);
  for (let i = 0; i < users.length; i += 500) {
    const chunk = users.slice(i, i + 500);
    await pool.query('INSERT INTO users (full_name, email, phone, password_hash, role) VALUES ?', [chunk.map(([n, e, ro]) => [n, e, '0803' + String(1000000 + Math.floor(r() * 8999999)), hash, ro])]);
  }
  await pool.query('INSERT INTO categories (category_name, description, default_priority, resolution_hours) VALUES ?', [CATEGORIES]);
  const [[{ firstCust }]] = await pool.query("SELECT MIN(user_id) AS firstCust FROM users WHERE role = 'customer'");
  const [offs] = await pool.query("SELECT user_id FROM users WHERE role = 'officer' ORDER BY user_id");
  const officerIds = offs.map((o) => o.user_id);
  const [cats] = await pool.query('SELECT category_id, default_priority, resolution_hours FROM categories ORDER BY category_id');

  const now = Date.now(), DAY = 86400000;
  const comps = [], ups = [], fbs = [];
  for (let i = 1; i <= nComp; i++) {
    const cat = pick(cats), submitted = new Date(now - Math.floor(r() * 180 * DAY));
    const due = new Date(submitted.getTime() + cat.resolution_hours * 3600000);
    const age = (now - submitted.getTime()) / DAY; const x = r();
    let status = 'Submitted';
    if (age > 1) status = x < 0.08 ? 'Submitted' : x < 0.18 ? 'Assigned' : x < 0.35 ? 'In Progress' : x < 0.55 ? 'Resolved' : 'Closed';
    const officer = status === 'Submitted' ? null : pick(officerIds);
    const resolved = ['Resolved', 'Closed'].includes(status) ? new Date(submitted.getTime() + (0.2 + r() * 1.6) * cat.resolution_hours * 3600000) : null;
    const closed = status === 'Closed' ? new Date(resolved.getTime() + r() * 3 * DAY) : null;
    const overdue = !resolved && due.getTime() < now;
    const escalated = (overdue && r() < 0.97) || (resolved && resolved > due && r() < 0.6) ? 1 : 0; // about 3% of overdue complaints are not yet escalated (job interval lag)
    const escAt = escalated ? new Date(Math.min(now, due.getTime() + 3600000)) : null;
    const ref = `CMP-${submitted.getUTCFullYear()}-${String(i).padStart(6, '0')}`;
    comps.push([ref, firstCust + Math.floor(r() * nCust), cat.category_id, officer, pick(SUBJECTS), 'Simulated complaint description for testing the complaint management system.', cat.default_priority, status, escalated, submitted, due, escAt, resolved, closed]);
    ups.push([i, null, 'Status Change', 'Complaint submitted', 1, submitted]);
    if (officer) ups.push([i, null, 'Assignment', 'Assigned to officer', 0, new Date(submitted.getTime() + 3600000)]);
    if (status !== 'Submitted' && status !== 'Assigned') { ups.push([i, officer, 'Officer Message', 'We are looking into your complaint.', 1, new Date(submitted.getTime() + 2 * 3600000)]); ups.push([i, officer, 'Note', 'Internal investigation note.', 0, new Date(submitted.getTime() + 3 * 3600000)]); }
    if (resolved) ups.push([i, officer, 'Resolution', 'The matter has been resolved.', 1, resolved]);
    if (status === 'Closed' && r() < 0.6) fbs.push([i, 1 + Math.floor(r() * 5), r() < 0.5 ? 'Thank you.' : null, closed]);
  }
  for (let i = 0; i < comps.length; i += 500) await pool.query('INSERT INTO complaints (reference_no, customer_id, category_id, assigned_officer_id, subject, description, priority, status, is_escalated, submitted_at, due_at, escalated_at, resolved_at, closed_at) VALUES ?', [comps.slice(i, i + 500)]);
  // a customer message for some complaints to bring history volume to roughly three updates per complaint
  for (let i = 1; i <= nComp; i++) if (r() < 0.3) ups.push([i, null, 'Customer Message', 'Any update please?', 1, new Date(now - Math.floor(r() * 60 * DAY))]);
  for (let i = 0; i < ups.length; i += 1000) await pool.query('INSERT INTO complaint_updates (complaint_id, author_id, update_type, message, visible_to_customer, created_at) VALUES ?', [ups.slice(i, i + 1000)]);
  if (fbs.length) await pool.query('INSERT INTO feedback (complaint_id, rating, comment, submitted_at) VALUES ?', [fbs]);
  const counts = {};
  for (const t of ['users', 'categories', 'complaints', 'complaint_updates', 'feedback']) { const [[x]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`); counts[t] = x.n; }
  console.log('Seeded:', JSON.stringify(counts), `in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
