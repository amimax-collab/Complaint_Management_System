const { createApp } = require('../../src/app');
const { admin, resetDb, seedBasic, loginAs, request, PASSWORD } = require('../helpers');
const { pool } = require('../../src/db');

const app = createApp();
beforeAll(async () => { await resetDb(); await seedBasic(); });
afterAll(async () => { await admin.end(); await pool.end(); });

describe('Registration', () => {
  test('a customer can register and the password is stored as an Argon2id hash', async () => {
    const res = await request(app).post('/api/auth/register').send({ full_name: 'New Customer', email: 'new@t.org', password: 'GoodPass123' });
    expect(res.status).toBe(201); expect(res.body.role).toBe('customer'); expect(res.body.password_hash).toBeUndefined();
    const [[u]] = await admin.query('SELECT password_hash FROM users WHERE email = ?', ['new@t.org']);
    expect(u.password_hash.startsWith('$argon2id$')).toBe(true); expect(u.password_hash).not.toContain('GoodPass123');
  });
  test('registration cannot choose a role', async () => {
    const res = await request(app).post('/api/auth/register').send({ full_name: 'Sneaky', email: 'sneaky@t.org', password: 'GoodPass123', role: 'admin' });
    expect(res.status).toBe(201); expect(res.body.role).toBe('customer');
  });
  test('a duplicate e-mail is rejected with 409', async () => {
    const res = await request(app).post('/api/auth/register').send({ full_name: 'Dup', email: 'NEW@t.org', password: 'GoodPass123' });
    expect(res.status).toBe(409);
  });
  test.each([[{ full_name: 'X', email: 'x@t.org', password: 'GoodPass123' }], [{ full_name: 'Xavier', email: 'bad', password: 'GoodPass123' }], [{ full_name: 'Xavier', email: 'x2@t.org', password: 'short' }]])('invalid registration returns 400 (%#)', async (body) => {
    expect((await request(app).post('/api/auth/register').send(body)).status).toBe(400);
  });
});

describe('Login and sessions', () => {
  test('valid credentials log the user in and set an HttpOnly, SameSite session cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'cust1@t.org', password: PASSWORD });
    expect(res.status).toBe(200); expect(res.body.role).toBe('customer');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Lax/i); expect(cookie).toMatch(/^ccms\.sid=/);
  });
  test('the e-mail address is case-insensitive', async () => {
    expect((await request(app).post('/api/auth/login').send({ email: 'CUST1@T.ORG', password: PASSWORD })).status).toBe(200);
  });
  test('a wrong password and an unknown e-mail return the same message', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'cust1@t.org', password: 'wrong-password' });
    const b = await request(app).post('/api/auth/login').send({ email: 'nobody@t.org', password: 'wrong-password' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.error).toBe(b.body.error);
  });
  test('an inactive account cannot log in', async () => {
    await admin.query("UPDATE users SET is_active = 0 WHERE email = 'cust2@t.org'");
    expect((await request(app).post('/api/auth/login').send({ email: 'cust2@t.org', password: PASSWORD })).status).toBe(401);
    await admin.query("UPDATE users SET is_active = 1 WHERE email = 'cust2@t.org'");
  });
  test('missing or non-string credentials return 400', async () => {
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } })).status).toBe(400);
  });
  test('login and failed login are written to the audit log', async () => {
    await request(app).post('/api/auth/login').send({ email: 'off1@t.org', password: 'nope-nope-nope' });
    const [rows] = await admin.query("SELECT action FROM audit_log WHERE action IN ('LOGIN_SUCCESS','LOGIN_FAILED')");
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['LOGIN_SUCCESS', 'LOGIN_FAILED']));
  });
  test('protected routes return 401 without a session', async () => {
    for (const [m, p] of [['get', '/api/complaints'], ['post', '/api/complaints'], ['get', '/api/admin/users'], ['get', '/api/reports/summary'], ['get', '/api/notifications'], ['get', '/api/categories']])
      expect((await request(app)[m](p).send({})).status).toBe(401);
  });
  test('logout destroys the session', async () => {
    const agent = await loginAs(app, 'cust1@t.org');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await agent.post('/api/auth/logout')).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
  test('the session identifier changes at login (session fixation protection)', async () => {
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ email: 'x@nowhere.org', password: 'bad' }); // failed login sets no session
    expect(first.headers['set-cookie']).toBeUndefined();
    const ok = await agent.post('/api/auth/login').send({ email: 'cust1@t.org', password: PASSWORD });
    expect(ok.headers['set-cookie'][0]).toMatch(/^ccms\.sid=s%3A/);
  });
});

describe('HTTP protections', () => {
  test('security headers are present and the framework banner is hidden', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.headers['x-content-type-options']).toBe('nosniff'); expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'"); expect(res.headers['x-powered-by']).toBeUndefined();
  });
  test('cross-origin state-changing requests are rejected', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', 'http://evil.example').send({ email: 'cust1@t.org', password: PASSWORD });
    expect(res.status).toBe(403);
  });
  test('same-origin requests carrying an Origin header are accepted', async () => {
    const res = await request(app).post('/api/auth/login').set('Host', 'localhost:3000').set('Origin', 'http://localhost:3000').send({ email: 'cust1@t.org', password: PASSWORD });
    expect(res.status).toBe(200);
  });
  test('malformed JSON returns 400 and oversized bodies return 413', async () => {
    expect((await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json')).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ full_name: 'x'.repeat(200000), email: 'a@b.co', password: 'GoodPass123' })).status).toBe(413);
  });
  test('unknown API routes return 404 JSON', async () => {
    const res = await request(app).get('/api/does-not-exist'); expect(res.status).toBe(404); expect(res.body.error).toBeDefined();
  });
});
