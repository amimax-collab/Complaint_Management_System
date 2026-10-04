const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../../src/app');
const config = require('../../src/config');
const { admin, resetDb, seedBasic, loginAs, validComplaint, request, PASSWORD } = require('../helpers');
const { pool } = require('../../src/db');

const app = createApp();
let S, cust1, cust2, sup, off1;
const INJECTIONS = ["' OR '1'='1", "'; DROP TABLE users; --", "1; DELETE FROM complaints", "\" OR \"\"=\"", "' UNION SELECT user_id, password_hash FROM users --", "admin'--", '\\', '%00'];
beforeAll(async () => {
  await resetDb(); S = await seedBasic();
  [cust1, cust2, sup, off1] = await Promise.all(['cust1@t.org', 'cust2@t.org', 'sup@t.org', 'off1@t.org'].map((e) => loginAs(app, e)));
});
afterAll(async () => { await admin.end(); await pool.end(); });

const tableCounts = async () => { const o = {}; for (const t of ['users', 'categories', 'complaints']) o[t] = (await admin.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n; return o; };

describe('SQL injection (OWASP A03)', () => {
  test.each(INJECTIONS)('login with injection payload %j does not authenticate', async (p) => {
    const before = await tableCounts();
    const res = await request(app).post('/api/auth/login').send({ email: p, password: p });
    expect([400, 401]).toContain(res.status); expect(await tableCounts()).toEqual(before);
  });
  test.each(INJECTIONS)('complaint text %j is stored as literal data', async (p) => {
    const before = await tableCounts();
    const subject = ('Subject ' + p).slice(0, 150); const description = ('Description text for testing ' + p).padEnd(40, '.');
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing, { subject, description }));
    expect(res.status).toBe(201);
    const after = await tableCounts(); expect(after.users).toBe(before.users); expect(after.complaints).toBe(before.complaints + 1);
    const [[row]] = await admin.query('SELECT subject, description FROM complaints WHERE complaint_id = ?', [res.body.complaint_id]);
    expect(row.subject).toBe(subject); expect(row.description).toBe(description);
  });
  test.each(INJECTIONS)('injection payload %j in a query string or URL is rejected or harmless', async (p) => {
    const before = await tableCounts();
    const enc = encodeURIComponent(p);
    expect([400]).toContain((await sup.get('/api/complaints?status=' + enc)).status);
    expect([400]).toContain((await sup.get('/api/complaints/ref/' + enc)).status);
    expect([400, 404]).toContain((await sup.get('/api/complaints/' + enc)).status);
    expect(await tableCounts()).toEqual(before);
  });
  test('injection in a message and in feedback comments is stored literally', async () => {
    const c = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    const res = await cust1.post(`/api/complaints/${c.body.complaint_id}/messages`).send({ message: "x'); DROP TABLE complaints; --" });
    expect(res.status).toBe(201); expect(res.body.history.some((h) => h.message === "x'); DROP TABLE complaints; --")).toBe(true);
    expect((await admin.query('SELECT COUNT(*) n FROM complaints'))[0][0].n).toBeGreaterThan(0);
  });
  test('the application database account cannot alter the schema or manage accounts', async () => {
    const conn = await mysql.createConnection({ host: config.db.host, user: config.db.user, password: config.db.password, database: config.db.database });
    await expect(conn.query('DROP TABLE audit_log')).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await expect(conn.query('TRUNCATE TABLE users')).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await expect(conn.query('ALTER TABLE users ADD COLUMN x INT')).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await expect(conn.query("CREATE USER 'evil'@'%' IDENTIFIED BY 'x'")).rejects.toBeTruthy();
    await conn.end();
  });
});

describe('Broken access control (OWASP A01)', () => {
  let victim;
  beforeAll(async () => { victim = (await cust1.post('/api/complaints').send(validComplaint(S.billing))).body; });
  test('a customer cannot read, message, rate or alter another customer\'s complaint by guessing identifiers', async () => {
    const id = victim.complaint_id;
    expect((await cust2.get('/api/complaints/' + id)).status).toBe(404);
    expect((await cust2.get('/api/complaints/ref/' + victim.reference_no)).status).toBe(404);
    expect((await cust2.post(`/api/complaints/${id}/messages`).send({ message: 'intruder message' })).status).toBe(404);
    expect((await cust2.post(`/api/complaints/${id}/feedback`).send({ rating: 1 })).status).toBe(404);
    expect((await cust2.post(`/api/complaints/${id}/status`).send({ status: 'In Progress' })).status).toBe(403);
    expect((await cust2.post(`/api/complaints/${id}/assign`).send({})).status).toBe(403);
  });
  test('enumerating identifiers as another customer never returns data', async () => {
    const [ids] = await admin.query('SELECT complaint_id FROM complaints WHERE customer_id = ?', [S.ids.cust1]);
    for (const { complaint_id } of ids) expect((await cust2.get('/api/complaints/' + complaint_id)).status).toBe(404);
  });
  test('mass assignment: privileged fields supplied by a customer are ignored', async () => {
    const res = await cust2.post('/api/complaints').send(validComplaint(S.billing, { status: 'Closed', customer_id: S.ids.cust1, assigned_officer_id: S.ids.off1, is_escalated: 1, due_at: '2000-01-01', reference_no: 'CMP-2000-000001', priority: 'Low' }));
    expect(res.status).toBe(201);
    const [[row]] = await admin.query('SELECT * FROM complaints WHERE complaint_id = ?', [res.body.complaint_id]);
    expect(row).toMatchObject({ status: 'Submitted', customer_id: S.ids.cust2, assigned_officer_id: null, is_escalated: 0, priority: 'High' }); expect(row.reference_no).not.toBe('CMP-2000-000001'); expect(row.due_at.getFullYear()).toBeGreaterThan(2000);
  });
  test('a role cannot be escalated through registration or profile routes', async () => {
    const res = await request(app).post('/api/auth/register').send({ full_name: 'Mallory', email: 'mal@t.org', password: 'GoodPass123', role: 'admin', is_active: 1 });
    expect(res.body.role).toBe('customer');
    expect((await cust1.patch('/api/admin/users/' + S.ids.cust1).send({ role: 'admin' })).status).toBe(403);
  });
  test('an officer cannot read complaints assigned to another officer', async () => {
    await sup.post(`/api/complaints/${victim.complaint_id}/assign`).send({ officer_id: S.ids.off2 });
    expect((await off1.get('/api/complaints/' + victim.complaint_id)).status).toBe(404);
    expect((await off1.post(`/api/complaints/${victim.complaint_id}/messages`).send({ message: 'peeking at it' })).status).toBe(403);
  });
  test('access to hidden files and path traversal is refused', async () => {
    for (const p of ['/.env', '/..%2f.env', '/../.env', '/%2e%2e/package.json', '/src/config.js', '/db/schema.sql']) expect((await request(app).get(p)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('Cryptographic failures and data exposure (OWASP A02)', () => {
  test('no response contains a password hash', async () => {
    const bodies = [(await cust1.get('/api/auth/me')).text, (await cust1.get('/api/complaints')).text, (await request(app).post('/api/auth/login').send({ email: 'cust1@t.org', password: PASSWORD })).text];
    for (const b of bodies) expect(b).not.toMatch(/\$argon2/); // an actual hash value (user text may legitimately mention the word)
    expect(Object.keys(JSON.parse(bodies[2]))).not.toContain('password_hash');
  });
  test('no plaintext password is stored anywhere in the database', async () => {
    const [rows] = await admin.query('SELECT password_hash FROM users');
    expect(rows.every((r) => r.password_hash.startsWith('$argon2id$'))).toBe(true);
    const [al] = await admin.query('SELECT details FROM audit_log WHERE details IS NOT NULL'); expect(JSON.stringify(al)).not.toContain(PASSWORD);
  });
  test('two users who register with the same password receive different hashes (salted)', async () => {
    await request(app).post('/api/auth/register').send({ full_name: 'Salt One', email: 'salt1@t.org', password: 'SamePassword123' });
    await request(app).post('/api/auth/register').send({ full_name: 'Salt Two', email: 'salt2@t.org', password: 'SamePassword123' });
    const [rows] = await admin.query("SELECT password_hash FROM users WHERE email IN ('salt1@t.org','salt2@t.org')");
    expect(rows).toHaveLength(2); expect(rows[0].password_hash).not.toBe(rows[1].password_hash);
  });
  test('the source tree contains no hard-coded credentials and .env is not committed', () => {
    const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8'); expect(gi).toMatch(/^\.env$/m);
    for (const f of ['src/config.js', 'src/db.js', 'src/app.js']) expect(fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')).not.toMatch(/password\s*[:=]\s*['"][^'"]{3,}['"]/i);
  });
});

describe('Injection of markup (stored cross-site scripting)', () => {
  test('markup is stored as inert text, returned as JSON, and the client renders it with textContent', async () => {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing, { subject: ('XSS ' + xss).slice(0, 150) }));
    const detail = await cust1.get('/api/complaints/' + res.body.complaint_id);
    expect(detail.headers['content-type']).toMatch(/application\/json/); expect(detail.headers['x-content-type-options']).toBe('nosniff');
    expect(detail.body.subject).toContain('<script>');
    const client = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
    expect(client).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  test('the content security policy forbids inline scripts and framing', async () => {
    const csp = (await request(app).get('/')).headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'"); expect(csp).not.toContain('unsafe-inline'); expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('Denial of service and abuse resistance', () => {
  test('very long field values are rejected before reaching the database', async () => {
    expect((await cust1.post('/api/complaints').send(validComplaint(S.billing, { subject: 'x'.repeat(5000) }))).status).toBe(400);
    expect((await cust1.post('/api/complaints').send(validComplaint(S.billing, { description: 'x'.repeat(50000) }))).status).toBe(400);
  });
  test('pagination limits cannot be abused to dump the table', async () => {
    const res = await sup.get('/api/complaints?limit=1000000'); expect(res.body.length).toBeLessThanOrEqual(100);
  });
  test('prototype pollution style bodies do not alter behaviour', async () => {
    const res = await cust1.post('/api/complaints').send(JSON.parse('{"__proto__":{"role":"admin"},"constructor":{"prototype":{"role":"admin"}},"category_id":' + S.billing + ',"subject":"Prototype pollution test","description":"Testing that prototype keys are ignored by the server."}'));
    expect(res.status).toBe(201); expect(({}).role).toBeUndefined();
    expect((await cust1.get('/api/admin/users')).status).toBe(403);
  });
});
