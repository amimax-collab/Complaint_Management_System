// Response-time measurements over real HTTP against the seeded database (Section 4.7.3).
// Usage: node scripts/perf.js [outputFile]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { performance } = require('perf_hooks');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { runScheduledJobs } = require('../src/scheduler/escalation');

const PORT = 3100, BASE = `http://127.0.0.1:${PORT}/api`;
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, mean: a.reduce((x, y) => x + y, 0) / a.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1] }; };
const r2 = (x) => Math.round(x * 100) / 100;

async function login(email, password = 'Password123!') {
  const t0 = performance.now();
  const res = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const ms = performance.now() - t0;
  if (res.status !== 200) throw new Error('login failed ' + email + ' ' + res.status);
  return { cookie: res.headers.getSetCookie()[0].split(';')[0], ms };
}
async function call(cookie, method, path, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { ms: performance.now() - t0, status: res.status, body: text };
}
async function measure(label, n, fn, warm = 10) {
  for (let i = 0; i < warm; i++) await fn(i);
  const t = []; let bad = 0;
  for (let i = 0; i < n; i++) { const r = await fn(i); t.push(r.ms); if (r.status >= 400) bad++; }
  const s = stats(t); console.log(label.padEnd(46), `n=${s.n}`, `mean ${r2(s.mean)} ms`, `median ${r2(s.median)}`, `p95 ${r2(s.p95)}`, bad ? `ERRORS ${bad}` : ''); return { label, ...s, errors: bad };
}

async function main() {
  const server = createApp().listen(PORT);
  const out = { date: new Date().toISOString(), db: process.env.DB_NAME || 'complaint_mgmt_db', results: [], concurrency: [] };
  const [[c]] = await pool.query('SELECT (SELECT COUNT(*) FROM complaints) complaints, (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM complaint_updates) updates');
  out.counts = c; console.log('Data volume:', JSON.stringify(c));

  const sup = await login('supervisor1@example.org'), adm = await login('admin@example.org'), off = await login('officer1@example.org');
  const [[cu]] = await pool.query("SELECT user_id, email FROM users WHERE role='customer' ORDER BY user_id LIMIT 1");
  const cust = await login(cu.email);
  const [[refRow]] = await pool.query('SELECT complaint_id, reference_no FROM complaints WHERE customer_id = ? LIMIT 1', [cu.user_id]);
  const [cats] = await pool.query('SELECT category_id FROM categories');

  // Login: Argon2id verification is deliberately slow
  const lt = []; for (let i = 0; i < 30; i++) lt.push((await login('customer' + (i + 1) + '@example.org')).ms);
  const ls = stats(lt); out.results.push({ label: 'POST /auth/login (Argon2id verification)', ...ls, errors: 0 }); console.log('POST /auth/login'.padEnd(46), `n=30 mean ${r2(ls.mean)} ms median ${r2(ls.median)} p95 ${r2(ls.p95)}`);

  out.results.push(await measure('GET /complaints (supervisor, first 25)', 200, () => call(sup.cookie, 'GET', '/complaints?limit=25')));
  out.results.push(await measure('GET /complaints?status=In Progress (supervisor)', 200, () => call(sup.cookie, 'GET', '/complaints?status=In%20Progress&limit=25')));
  out.results.push(await measure('GET /complaints (customer, own complaints)', 200, () => call(cust.cookie, 'GET', '/complaints')));
  out.results.push(await measure('GET /complaints (officer, assigned)', 200, () => call(off.cookie, 'GET', '/complaints')));
  out.results.push(await measure('GET /complaints/ref/:reference (track)', 200, () => call(cust.cookie, 'GET', '/complaints/ref/' + refRow.reference_no)));
  out.results.push(await measure('GET /complaints/:id (detail with history)', 200, () => call(cust.cookie, 'GET', '/complaints/' + refRow.complaint_id)));
  out.results.push(await measure('POST /complaints (submit)', 100, (i) => call(cust.cookie, 'POST', '/complaints', { category_id: cats[i % cats.length].category_id, subject: 'Performance test complaint ' + i, description: 'This complaint was created by the automated performance test run.' })));
  out.results.push(await measure('GET /officers (workload and suggestion)', 100, () => call(sup.cookie, 'GET', '/officers')));
  out.results.push(await measure('GET /reports/summary (supervisor)', 100, () => call(sup.cookie, 'GET', '/reports/summary')));
  out.results.push(await measure('GET /admin/audit?limit=200', 100, () => call(adm.cookie, 'GET', '/admin/audit?limit=200')));

  // Concurrency: many simultaneous users tracking and listing complaints
  async function load(label, total, conc, fn) {
    let next = 0; const times = []; let bad = 0; const t0 = performance.now();
    await Promise.all(Array.from({ length: conc }, async () => { while (true) { const i = next++; if (i >= total) return; const r = await fn(i); times.push(r.ms); if (r.status >= 400) bad++; } }));
    const secs = (performance.now() - t0) / 1000, s = stats(times);
    const row = { label, total, concurrency: conc, seconds: r2(secs), throughput: r2(total / secs), median: r2(s.median), p95: r2(s.p95), max: r2(s.max), errors: bad };
    console.log(label.padEnd(40), JSON.stringify(row)); out.concurrency.push(row);
  }
  for (const conc of [10, 25, 50]) await load('Mixed read workload', 500, conc, (i) => i % 2 ? call(cust.cookie, 'GET', '/complaints/ref/' + refRow.reference_no) : call(sup.cookie, 'GET', '/complaints?limit=25'));

  // Scheduled job on the seeded data (first run does the work, second run finds nothing)
  let t0 = performance.now(); const r1 = await runScheduledJobs(); const d1 = performance.now() - t0;
  t0 = performance.now(); const r2_ = await runScheduledJobs(); const d2 = performance.now() - t0;
  out.scheduler = { first: { ...r1, ms: r2(d1) }, second: { ...r2_, ms: r2(d2) } };
  console.log('Escalation job, first run :', JSON.stringify(out.scheduler.first)); console.log('Escalation job, second run:', JSON.stringify(out.scheduler.second));

  out.memory_mb = r2(process.memoryUsage().rss / 1048576);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  server.close(); await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
