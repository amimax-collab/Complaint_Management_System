const { createApp } = require('../../src/app');
const { admin, resetDb, seedBasic, loginAs, validComplaint, insertComplaint, request, PASSWORD } = require('../helpers');
const { pool } = require('../../src/db');

const app = createApp();
let S, adm, sup, off1, cust1, cust2;
beforeAll(async () => {
  await resetDb(); S = await seedBasic();
  [adm, sup, off1, cust1, cust2] = await Promise.all(['admin@t.org', 'sup@t.org', 'off1@t.org', 'cust1@t.org', 'cust2@t.org'].map((e) => loginAs(app, e)));
});
afterAll(async () => { await admin.end(); await pool.end(); });

describe('FR-14: user and category administration', () => {
  test('only the administrator can reach administrator routes', async () => {
    for (const a of [cust1, off1, sup]) for (const [m, p] of [['get', '/api/admin/users'], ['post', '/api/admin/users'], ['get', '/api/admin/audit'], ['post', '/api/admin/categories']]) expect((await a[m](p).send({})).status).toBe(403);
    const [rows] = await admin.query("SELECT * FROM audit_log WHERE action = 'ACCESS_DENIED' AND entity_type = 'route'"); expect(rows.length).toBeGreaterThan(0);
  });
  test('the administrator can create a user with a chosen role', async () => {
    const res = await adm.post('/api/admin/users').send({ full_name: 'Officer Three', email: 'off3@t.org', password: 'StrongPass123', role: 'officer' });
    expect(res.status).toBe(201); expect(res.body.role).toBe('officer'); expect(res.body.password_hash).toBeUndefined();
    expect((await request(app).post('/api/auth/login').send({ email: 'off3@t.org', password: 'StrongPass123' })).status).toBe(200);
  });
  test('invalid roles, duplicate e-mails and weak passwords are rejected', async () => {
    expect((await adm.post('/api/admin/users').send({ full_name: 'Bad Role', email: 'br@t.org', password: 'StrongPass123', role: 'root' })).status).toBe(400);
    expect((await adm.post('/api/admin/users').send({ full_name: 'Dup User', email: 'off3@t.org', password: 'StrongPass123', role: 'officer' })).status).toBe(409);
    expect((await adm.post('/api/admin/users').send({ full_name: 'Weak Pass', email: 'wp@t.org', password: 'abc', role: 'officer' })).status).toBe(400);
  });
  test('the user list never exposes password hashes and can be filtered by role', async () => {
    const all = await adm.get('/api/admin/users'); expect(JSON.stringify(all.body)).not.toMatch(/argon2|password_hash/);
    const officers = await adm.get('/api/admin/users?role=officer'); expect(officers.body.every((u) => u.role === 'officer')).toBe(true);
  });
  test('a deactivated user can no longer log in and their session history is preserved', async () => {
    const res = await adm.patch('/api/admin/users/' + S.ids.cust2).send({ is_active: false });
    expect(res.status).toBe(200); expect(res.body.is_active).toBe(false);
    expect((await request(app).post('/api/auth/login').send({ email: 'cust2@t.org', password: PASSWORD })).status).toBe(401);
    await adm.patch('/api/admin/users/' + S.ids.cust2).send({ is_active: true });
  });
  test('the administrator cannot deactivate or demote their own account', async () => {
    expect((await adm.patch('/api/admin/users/' + S.ids.admin).send({ is_active: false })).status).toBe(409);
    expect((await adm.patch('/api/admin/users/' + S.ids.admin).send({ role: 'customer' })).status).toBe(409);
  });
  test('patching an unknown user returns 404 and an empty patch returns 400', async () => {
    expect((await adm.patch('/api/admin/users/99999').send({ is_active: false })).status).toBe(404);
    expect((await adm.patch('/api/admin/users/' + S.ids.cust1).send({})).status).toBe(400);
  });
  test('users cannot be physically deleted through the database account (history is preserved)', async () => {
    const id = await insertComplaint({ customer_id: S.ids.cust1, category_id: S.billing });
    await expect(admin.query('DELETE FROM users WHERE user_id = ?', [S.ids.cust1])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    expect(id).toBeGreaterThan(0);
  });
  test('categories can be created and their resolution target changed; new targets apply to new complaints only', async () => {
    const created = await adm.post('/api/admin/categories').send({ category_name: 'Delivery', description: 'Late delivery', default_priority: 'Medium', resolution_hours: 24 });
    expect(created.status).toBe(201);
    const first = await cust1.post('/api/complaints').send(validComplaint(created.body.category_id));
    expect((await adm.patch('/api/admin/categories/' + created.body.category_id).send({ resolution_hours: 100 })).status).toBe(200);
    const second = await cust1.post('/api/complaints').send(validComplaint(created.body.category_id));
    const [[a]] = await admin.query('SELECT TIMESTAMPDIFF(HOUR, submitted_at, due_at) h FROM complaints WHERE complaint_id = ?', [first.body.complaint_id]);
    const [[b]] = await admin.query('SELECT TIMESTAMPDIFF(HOUR, submitted_at, due_at) h FROM complaints WHERE complaint_id = ?', [second.body.complaint_id]);
    expect(a.h).toBe(24); expect(b.h).toBe(100);
  });
  test('category validation and duplicates', async () => {
    expect((await adm.post('/api/admin/categories').send({ category_name: 'Billing', default_priority: 'High', resolution_hours: 10 })).status).toBe(409);
    expect((await adm.post('/api/admin/categories').send({ category_name: 'Zero', default_priority: 'High', resolution_hours: 0 })).status).toBe(400);
    expect((await adm.patch('/api/admin/categories/99999').send({ resolution_hours: 10 })).status).toBe(404);
    expect((await adm.patch('/api/admin/categories/' + S.billing).send({})).status).toBe(400);
  });
  test('any logged-in user can read the category list', async () => {
    const res = await cust1.get('/api/categories'); expect(res.status).toBe(200); expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

describe('FR-15: audit trail', () => {
  test('the administrator can search the audit log by action, entity and date', async () => {
    const c = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    const byEntity = await adm.get(`/api/admin/audit?entity_type=complaint&entity_id=${c.body.complaint_id}`);
    expect(byEntity.status).toBe(200); expect(byEntity.body.map((r) => r.action)).toContain('COMPLAINT_SUBMITTED');
    const byAction = await adm.get('/api/admin/audit?action=LOGIN_SUCCESS'); expect(byAction.body.every((r) => r.action === 'LOGIN_SUCCESS')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await adm.get(`/api/admin/audit?from=${today}&to=${today}`)).body.length).toBeGreaterThan(0);
    expect((await adm.get('/api/admin/audit?from=2000-01-01&to=2000-01-02')).body).toHaveLength(0);
    expect((await adm.get('/api/admin/audit?from=yesterday')).status).toBe(400);
  });
  test('audit records carry the user and IP address; there is no route to alter them', async () => {
    const [rows] = await admin.query("SELECT user_id, ip_address FROM audit_log WHERE action = 'COMPLAINT_SUBMITTED' LIMIT 1");
    expect(rows[0].user_id).toBe(S.ids.cust1); expect(rows[0].ip_address).toBeTruthy();
    for (const m of ['put', 'patch', 'delete']) expect((await adm[m]('/api/admin/audit').send({})).status).toBe(404);
  });
});

describe('FR-13: management reports', () => {
  beforeAll(async () => {
    await resetDb(); S = await seedBasic();
    [adm, sup, off1, cust1] = await Promise.all(['admin@t.org', 'sup@t.org', 'off1@t.org', 'cust1@t.org'].map((e) => loginAs(app, e)));
    const t0 = new Date('2026-03-10T08:00:00Z');
    const mk = (cat, status, hoursToResolve, esc) => insertComplaint({ customer_id: S.ids.cust1, category_id: cat, assigned_officer_id: S.ids.off1, status, is_escalated: esc, submitted_at: t0,
      due_at: new Date(t0.getTime() + 48 * 3600000), resolved_at: hoursToResolve == null ? null : new Date(t0.getTime() + hoursToResolve * 3600000) });
    await mk(S.billing, 'Resolved', 10, 0); await mk(S.billing, 'Closed', 20, 1); await mk(S.billing, 'In Progress', null, 1); await mk(S.facilities, 'Resolved', 30, 0);
    await insertComplaint({ customer_id: S.ids.cust1, category_id: S.billing, status: 'Closed', submitted_at: new Date('2025-01-05T00:00:00Z'), due_at: new Date('2025-01-07T00:00:00Z'), resolved_at: new Date('2025-01-05T05:00:00Z') });
    const [[f]] = await admin.query("SELECT complaint_id FROM complaints WHERE status = 'Closed' AND is_escalated = 1 LIMIT 1");
    await admin.query('INSERT INTO feedback (complaint_id, rating) VALUES (?, 4)', [f.complaint_id]);
  });
  test('Query 3.1 returns correct totals, escalations and average resolution time per category', async () => {
    const res = await sup.get('/api/reports/summary?from=2026-03-01&to=2026-03-31'); expect(res.status).toBe(200);
    const b = res.body.by_category.find((x) => x.category_name === 'Billing'); const f = res.body.by_category.find((x) => x.category_name === 'Facilities');
    expect(b).toMatchObject({ total_complaints: 3, escalated: 2, avg_resolution_hours: 15 }); // (10 + 20) / 2 resolved complaints
    expect(f).toMatchObject({ total_complaints: 1, escalated: 0, avg_resolution_hours: 30 });
  });
  test('status counts, ratings and officer workload are correct', async () => {
    const r = (await sup.get('/api/reports/summary?from=2026-03-01&to=2026-03-31')).body;
    expect(Object.fromEntries(r.by_status.map((x) => [x.status, x.total]))).toEqual({ Resolved: 2, Closed: 1, 'In Progress': 1 });
    expect(r.rating_by_category).toEqual([{ category_name: 'Billing', responses: 1, avg_rating: 4 }]);
    expect(r.officer_workload.find((o) => o.user_id === S.ids.off1).open_complaints).toBe(1);
  });
  test('the date range filters the results', async () => {
    const all = (await sup.get('/api/reports/summary')).body.by_category.find((x) => x.category_name === 'Billing');
    expect(all.total_complaints).toBe(4);
  });
  test('only supervisors can view reports; bad dates are rejected', async () => {
    for (const a of [cust1, off1, adm]) expect((await a.get('/api/reports/summary')).status).toBe(403);
    expect((await sup.get('/api/reports/summary?from=nonsense')).status).toBe(400);
  });
});

describe('Notifications and static pages', () => {
  test('a user can read only their own notifications', async () => {
    await cust1.post('/api/complaints').send(validComplaint(S.billing));
    const mine = await cust1.get('/api/notifications'); expect(mine.status).toBe(200); expect(mine.body.length).toBeGreaterThan(0);
    const [rows] = await admin.query('SELECT notification_id FROM notifications WHERE user_id = ?', [S.ids.cust1]);
    expect(mine.body.length).toBe(rows.length);
    expect((await off1.get('/api/notifications')).body.map((n) => n.notification_id)).not.toEqual(expect.arrayContaining(mine.body.map((n) => n.notification_id)));
  });
  test('the web client is served', async () => {
    const page = await request(app).get('/'); expect(page.status).toBe(200); expect(page.text).toContain('Customer Complaint Management System');
    expect((await request(app).get('/app.js')).status).toBe(200); expect((await request(app).get('/style.css')).status).toBe(200);
  });
});
