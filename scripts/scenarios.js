// Runs representative end-to-end scenarios against the test database and records the actual responses (Table 4.5).
process.env.NODE_ENV = 'test'; process.env.DB_NAME = 'complaint_mgmt_test'; process.env.SESSION_SECRET = 'scenario-secret';
const fs = require('fs');
const { createApp } = require('../src/app');
const { admin, resetDb, seedBasic, loginAs, validComplaint, insertComplaint, request, PASSWORD } = require('../tests/helpers');
const { runScheduledJobs } = require('../src/scheduler/escalation');
const { pool } = require('../src/db');

(async () => {
  const app = createApp(); await resetDb(); const S = await seedBasic(); const out = [];
  const rec = (id, name, input, expected, actual, pass) => { out.push({ id, name, input, expected, actual, pass }); console.log(id, pass ? 'PASS' : 'FAIL', '|', actual); };
  const cust1 = await loginAs(app, 'cust1@t.org'), cust2 = await loginAs(app, 'cust2@t.org'), sup = await loginAs(app, 'sup@t.org'), off1 = await loginAs(app, 'off1@t.org');

  let r = await request(app).post('/api/auth/register').send({ full_name: 'Ada Obi', email: 'ada@t.org', password: 'GoodPass123' });
  rec('TC-01', 'Customer registration', 'Valid name, e-mail and password', '201; role customer; no password in response', `${r.status}; role ${r.body.role}; password_hash in response: ${'password_hash' in r.body}`, r.status === 201 && r.body.role === 'customer' && !('password_hash' in r.body));

  r = await request(app).post('/api/auth/login').send({ email: 'cust1@t.org', password: 'wrong-password-1' });
  const r2 = await request(app).post('/api/auth/login').send({ email: 'cust1@t.org', password: PASSWORD });
  rec('TC-02', 'Login with wrong and correct password', 'Wrong password, then correct password', '401 then 200', `${r.status} "${r.body.error}" then ${r2.status} (role ${r2.body.role})`, r.status === 401 && r2.status === 200);

  r = await cust1.post('/api/complaints').send(validComplaint(S.billing));
  const [[row]] = await admin.query('SELECT TIMESTAMPDIFF(HOUR, submitted_at, due_at) h, status, priority FROM complaints WHERE complaint_id = ?', [r.body.complaint_id]);
  const ref = r.body.reference_no, cid = r.body.complaint_id;
  rec('TC-03', 'Submit a complaint (Billing)', 'Valid category, subject and description', '201; reference CMP-YYYY-NNNNNN; due 48 hours later; status Submitted', `${r.status}; ${ref}; due after ${row.h} hours; status ${row.status}; priority ${row.priority}`, r.status === 201 && /^CMP-\d{4}-\d{6}$/.test(ref) && row.h === 48);

  r = await cust1.post('/api/complaints').send(validComplaint(S.billing, { subject: 'abc' }));
  rec('TC-04', 'Submit with invalid input', 'Subject of 3 characters', '400 with a field message; nothing stored', `${r.status}; ${JSON.stringify(r.body.details)}`, r.status === 400);

  r = await cust1.get('/api/complaints/ref/' + ref);
  rec('TC-05', 'Track by reference number (owner)', `Reference ${ref}`, '200 with current status', `${r.status}; status ${r.body.status}; category ${r.body.category_name}`, r.status === 200 && r.body.status === 'Submitted');

  r = await cust2.get('/api/complaints/ref/' + ref);
  rec('TC-06', 'Track another customer\'s complaint', 'Same reference as a different customer', '404 (existence not revealed)', `${r.status} "${r.body.error}"`, r.status === 404);

  r = await sup.post(`/api/complaints/${cid}/assign`).send({});
  rec('TC-07', 'Supervisor assigns with suggested officer', 'No officer chosen', '200; status Assigned; least-loaded officer', `${r.status}; status ${r.body.status}; officer id ${r.body.assigned_officer_id} (expected ${S.ids.off1})`, r.status === 200 && r.body.status === 'Assigned');

  r = await off1.post(`/api/complaints/${cid}/status`).send({ status: 'Resolved', note: 'Trying to skip a stage here' });
  rec('TC-08', 'Skip a lifecycle stage', 'Assigned to Resolved', '409 transition not permitted', `${r.status} "${r.body.error}"`, r.status === 409);

  await off1.post(`/api/complaints/${cid}/status`).send({ status: 'In Progress' });
  r = await off1.post(`/api/complaints/${cid}/status`).send({ status: 'Resolved', note: 'Duplicate charge reversed and confirmed with the bank.' });
  rec('TC-09', 'Officer resolves the complaint', 'In Progress to Resolved with a note', '200; status Resolved; resolved_at set', `${r.status}; status ${r.body.status}; resolved_at set: ${!!r.body.resolved_at}`, r.status === 200 && r.body.status === 'Resolved');

  r = await cust1.post(`/api/complaints/${cid}/feedback`).send({ rating: 4, comment: 'Thank you.' });
  rec('TC-10', 'Customer gives feedback', 'Rating 4 on a resolved complaint', '201; complaint becomes Closed', `${r.status}; status ${r.body.status}; rating ${r.body.feedback && r.body.feedback.rating}`, r.status === 201 && r.body.status === 'Closed');

  const od = await insertComplaint({ customer_id: S.ids.cust1, category_id: S.billing, status: 'In Progress', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - 3600000) });
  const j1 = await runScheduledJobs(), j2 = await runScheduledJobs();
  const [[e]] = await admin.query('SELECT is_escalated FROM complaints WHERE complaint_id = ?', [od]);
  rec('TC-11', 'Escalation of an overdue complaint', 'Complaint one hour past its due date; job run twice', 'Escalated once; second run escalates nothing', `first run escalated ${j1.escalated}, second run ${j2.escalated}; is_escalated = ${e.is_escalated}`, j1.escalated === 1 && j2.escalated === 0 && e.is_escalated === 1);

  const [[before]] = await admin.query('SELECT COUNT(*) n FROM users');
  r = await request(app).post('/api/auth/login').send({ email: "' OR '1'='1", password: "' OR '1'='1" });
  const r2_ = await cust1.post('/api/complaints').send(validComplaint(S.billing, { subject: "x'); DROP TABLE users; --" }));
  const [[after]] = await admin.query('SELECT COUNT(*) n FROM users'); const [[sub]] = await admin.query('SELECT subject FROM complaints WHERE complaint_id = ?', [r2_.body.complaint_id]);
  rec('TC-12', 'SQL injection attempt', "Login with ' OR '1'='1 and a subject containing DROP TABLE", 'Login rejected (400 or 401); text stored as data; tables intact', `login ${r.status}; complaint ${r2_.status}; stored subject "${sub.subject}"; users before ${before.n}, after ${after.n}`, [400, 401].includes(r.status) && r2_.status === 201 && before.n === after.n);

  r = await cust1.get('/api/admin/users');
  rec('TC-13', 'Customer calls an administrator route', 'GET /api/admin/users as a customer', '403 and an ACCESS_DENIED audit record', `${r.status} "${r.body.error}"`, r.status === 403);

  r = await cust2.post('/api/complaints').send(validComplaint(S.billing, { status: 'Closed', customer_id: S.ids.cust1, assigned_officer_id: S.ids.off1, is_escalated: 1 }));
  const [[m]] = await admin.query('SELECT status, customer_id, assigned_officer_id, is_escalated FROM complaints WHERE complaint_id = ?', [r.body.complaint_id]);
  rec('TC-14', 'Mass assignment attempt', 'Customer sends status, customer_id, assigned_officer_id and is_escalated', 'Extra fields ignored', `status ${m.status}; owner is the logged-in customer: ${m.customer_id === S.ids.cust2}; officer ${m.assigned_officer_id}; is_escalated ${m.is_escalated}`, m.status === 'Submitted' && m.customer_id === S.ids.cust2 && m.assigned_officer_id === null && m.is_escalated === 0);

  fs.writeFileSync(__dirname + '/../results/scenarios.json', JSON.stringify(out, null, 2));
  console.log(out.every((x) => x.pass) ? 'ALL SCENARIOS PASSED' : 'SOME FAILED');
  await admin.end(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
