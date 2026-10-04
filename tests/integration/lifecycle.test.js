const { createApp } = require('../../src/app');
const { admin, resetDb, seedBasic, loginAs, validComplaint, request } = require('../helpers');
const { pool } = require('../../src/db');
const notificationService = require('../../src/services/notificationService');
const audit = require('../../src/services/auditService');

const app = createApp();
let S, cust1, cust2, sup, off1, off2;
beforeAll(async () => {
  await resetDb(); S = await seedBasic();
  [cust1, cust2, sup, off1, off2] = await Promise.all(['cust1@t.org', 'cust2@t.org', 'sup@t.org', 'off1@t.org', 'off2@t.org'].map((e) => loginAs(app, e)));
});
afterAll(async () => { await admin.end(); await pool.end(); });

let complaint;

describe('FR-02 to FR-04: submission', () => {
  test('a customer can submit a complaint and receives a reference number and due date', async () => {
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    expect(res.status).toBe(201);
    expect(res.body.reference_no).toMatch(/^CMP-\d{4}-\d{6}$/);
    const [[row]] = await admin.query('SELECT * FROM complaints WHERE complaint_id = ?', [res.body.complaint_id]);
    expect(row.status).toBe('Submitted'); expect(row.priority).toBe('High'); expect(row.customer_id).toBe(S.ids.cust1);
    expect(row.reference_no).toBe(res.body.reference_no);
    const hours = (new Date(row.due_at) - new Date(row.submitted_at)) / 3600000;
    expect(hours).toBe(48); // Billing category target
    complaint = res.body;
  });
  test('reference numbers are unique and sequential in identifier', async () => {
    const a = await cust1.post('/api/complaints').send(validComplaint(S.facilities));
    const b = await cust2.post('/api/complaints').send(validComplaint(S.facilities));
    expect(a.body.reference_no).not.toBe(b.body.reference_no);
    expect(b.body.complaint_id).toBeGreaterThan(a.body.complaint_id);
    const [[f]] = await admin.query('SELECT priority, TIMESTAMPDIFF(HOUR, submitted_at, due_at) h FROM complaints WHERE complaint_id = ?', [a.body.complaint_id]);
    expect(f.priority).toBe('Low'); expect(f.h).toBe(168);
  });
  test('an acknowledgement notification is recorded and sent', async () => {
    const [rows] = await admin.query('SELECT * FROM notifications WHERE complaint_id = ?', [complaint.complaint_id]);
    expect(rows).toHaveLength(1); expect(rows[0].user_id).toBe(S.ids.cust1); expect(rows[0].delivery_status).toBe('Sent'); expect(rows[0].subject).toContain(complaint.reference_no);
  });
  test('the submission is written to the audit log', async () => {
    const [rows] = await admin.query("SELECT * FROM audit_log WHERE action = 'COMPLAINT_SUBMITTED' AND entity_id = ?", [complaint.complaint_id]);
    expect(rows).toHaveLength(1); expect(rows[0].user_id).toBe(S.ids.cust1);
  });
  test('an unknown category is rejected', async () => { expect((await cust1.post('/api/complaints').send(validComplaint(9999))).status).toBe(400); });
  test.each([[{ subject: 'abc' }], [{ description: 'short' }], [{ category_id: undefined }]])('invalid input is rejected without storing anything (%#)', async (extra) => {
    const [[before]] = await admin.query('SELECT COUNT(*) n FROM complaints');
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing, extra));
    expect(res.status).toBe(400);
    const [[after]] = await admin.query('SELECT COUNT(*) n FROM complaints'); expect(after.n).toBe(before.n);
  });
  test('only customers can submit complaints', async () => {
    for (const a of [off1, sup]) expect((await a.post('/api/complaints').send(validComplaint(S.billing))).status).toBe(403);
  });
  test('a failure part-way through leaves no partial record (transaction rollback)', async () => {
    const [[before]] = await admin.query('SELECT COUNT(*) n FROM complaints');
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    spy.mockRestore(); quiet.mockRestore();
    expect(res.status).toBe(500);
    const [[after]] = await admin.query('SELECT COUNT(*) n FROM complaints'); expect(after.n).toBe(before.n);
  });
  test('a failed e-mail does not block the complaint and is recorded as Failed', async () => {
    notificationService.setTransport({ sendMail: async () => { throw new Error('SMTP down'); } });
    const res = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    notificationService.setTransport(null);
    expect(res.status).toBe(201);
    const [rows] = await admin.query('SELECT delivery_status FROM notifications WHERE complaint_id = ?', [res.body.complaint_id]);
    expect(rows[0].delivery_status).toBe('Failed');
  });
});

describe('FR-05: tracking and visibility', () => {
  test('the customer can track by reference number', async () => {
    const res = await cust1.get('/api/complaints/ref/' + complaint.reference_no);
    expect(res.status).toBe(200); expect(res.body.status).toBe('Submitted'); expect(res.body.category_name).toBe('Billing');
  });
  test('another customer cannot see the complaint by id or by reference (404, existence not revealed)', async () => {
    expect((await cust2.get('/api/complaints/' + complaint.complaint_id)).status).toBe(404);
    expect((await cust2.get('/api/complaints/ref/' + complaint.reference_no)).status).toBe(404);
  });
  test('an officer cannot see an unassigned complaint', async () => { expect((await off1.get('/api/complaints/' + complaint.complaint_id)).status).toBe(404); });
  test('customers list only their own complaints', async () => {
    const res = await cust2.get('/api/complaints'); expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0); expect(res.body.every((c) => c.customer_id === S.ids.cust2)).toBe(true);
  });
  test('the supervisor sees all complaints and can filter by status', async () => {
    const all = await sup.get('/api/complaints'); expect(all.body.length).toBeGreaterThanOrEqual(3);
    const sub = await sup.get('/api/complaints?status=Submitted'); expect(sub.body.every((c) => c.status === 'Submitted')).toBe(true);
    expect((await sup.get('/api/complaints?status=Bogus')).status).toBe(400);
  });
  test('invalid reference formats and ids are rejected', async () => {
    expect((await cust1.get("/api/complaints/ref/CMP-1' OR '1'='1")).status).toBe(400);
    expect((await cust1.get('/api/complaints/abc')).status).toBe(400);
    expect((await cust1.get('/api/complaints/999999')).status).toBe(404);
    expect((await cust1.get('/api/complaints/ref/CMP-2026-999999')).status).toBe(404);
  });
});

describe('FR-07: assignment', () => {
  test('only a supervisor can assign', async () => {
    for (const a of [cust1, off1]) expect((await a.post(`/api/complaints/${complaint.complaint_id}/assign`).send({})).status).toBe(403);
  });
  test('assignment with no officer chosen uses the suggestion and moves the complaint to Assigned', async () => {
    const res = await sup.post(`/api/complaints/${complaint.complaint_id}/assign`).send({});
    expect(res.status).toBe(200); expect(res.body.status).toBe('Assigned'); expect(res.body.assigned_officer_id).toBe(S.ids.off1); // tie broken by lowest id
  });
  test('the officer and the customer are notified', async () => {
    const [rows] = await admin.query("SELECT user_id, subject FROM notifications WHERE complaint_id = ? AND (subject LIKE 'New complaint assigned%' OR subject LIKE 'Your complaint is being handled%')", [complaint.complaint_id]);
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r.subject]));
    expect(byUser[S.ids.off1]).toContain('New complaint assigned'); expect(byUser[S.ids.cust1]).toContain('being handled');
  });
  test('the assigned officer sees the complaint; the other officer does not', async () => {
    expect((await off1.get('/api/complaints/' + complaint.complaint_id)).status).toBe(200);
    expect((await off2.get('/api/complaints/' + complaint.complaint_id)).status).toBe(404);
    expect((await off1.get('/api/complaints')).body.map((c) => c.complaint_id)).toContain(complaint.complaint_id);
    expect((await off2.get('/api/complaints')).body.map((c) => c.complaint_id)).not.toContain(complaint.complaint_id);
  });
  test('the next suggestion goes to the officer with fewer open complaints', async () => {
    const res = await sup.get('/api/officers'); expect(res.body.suggested.user_id).toBe(S.ids.off2);
  });
  test('assigning to a non-officer or unknown user is rejected', async () => {
    expect((await sup.post(`/api/complaints/${complaint.complaint_id}/assign`).send({ officer_id: S.ids.cust1 })).status).toBe(400);
    expect((await sup.post(`/api/complaints/${complaint.complaint_id}/assign`).send({ officer_id: 99999 })).status).toBe(400);
  });
  test('reassignment keeps the current status', async () => {
    await off1.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'In Progress', note: 'Started' });
    const res = await sup.post(`/api/complaints/${complaint.complaint_id}/assign`).send({ officer_id: S.ids.off2 });
    expect(res.body.status).toBe('In Progress'); expect(res.body.assigned_officer_id).toBe(S.ids.off2);
    await sup.post(`/api/complaints/${complaint.complaint_id}/assign`).send({ officer_id: S.ids.off1 });
  });
  test('an inactive officer is never suggested', async () => {
    await admin.query('UPDATE users SET is_active = 0 WHERE user_id = ?', [S.ids.off2]);
    const res = await sup.get('/api/officers'); expect(res.body.officers.map((o) => o.user_id)).not.toContain(S.ids.off2);
    await admin.query('UPDATE users SET is_active = 1 WHERE user_id = ?', [S.ids.off2]);
  });
});

describe('FR-06: messages and internal notes', () => {
  test('the customer can send a message; the assigned officer is notified', async () => {
    const res = await cust1.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'Any update please?' });
    expect(res.status).toBe(201); expect(res.body.history.some((h) => h.update_type === 'Customer Message')).toBe(true);
  });
  test('the officer can reply to the customer and add an internal note', async () => {
    await off1.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'We are checking the payment records.' });
    await off1.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'Customer is a repeat complainant, handle with care.', internal: true });
  });
  test('internal notes are hidden from the customer but visible to staff', async () => {
    const asCustomer = (await cust1.get('/api/complaints/' + complaint.complaint_id)).body.history.map((h) => h.message);
    expect(asCustomer.some((m) => m.includes('repeat complainant'))).toBe(false); expect(asCustomer.some((m) => m.includes('payment records'))).toBe(true);
    const asOfficer = (await off1.get('/api/complaints/' + complaint.complaint_id)).body.history.map((h) => h.message);
    expect(asOfficer.some((m) => m.includes('repeat complainant'))).toBe(true);
    expect(asOfficer.some((m) => m.startsWith('Assigned to officer'))).toBe(true); expect(asCustomer.some((m) => m.startsWith('Assigned to officer'))).toBe(false);
  });
  test('a customer cannot post an internal note or write to someone else\'s complaint', async () => {
    expect((await cust1.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'secret note', internal: true })).status).toBe(403);
    expect((await cust2.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'hello there' })).status).toBe(404);
    expect((await off2.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'hello there' })).status).toBe(403);
  });
});

describe('FR-08 to FR-12: status workflow, resolution, feedback and closure', () => {
  test('a transition that skips a stage is rejected with 409', async () => {
    const r = await cust2.post('/api/complaints').send(validComplaint(S.billing));
    await sup.post(`/api/complaints/${r.body.complaint_id}/assign`).send({ officer_id: S.ids.off2 });
    const res = await off2.post(`/api/complaints/${r.body.complaint_id}/status`).send({ status: 'Resolved', note: 'Resolved too early here' });
    expect(res.status).toBe(409);
  });
  test('an officer cannot update a complaint that is not assigned to them', async () => {
    const res = await off2.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'Resolved', note: 'Trying to resolve it' });
    expect(res.status).toBe(403);
    const [rows] = await admin.query("SELECT * FROM audit_log WHERE action = 'ACCESS_DENIED' AND entity_id = ?", [complaint.complaint_id]); expect(rows.length).toBeGreaterThan(0);
  });
  test('a customer cannot change status', async () => {
    expect((await cust1.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'Resolved', note: 'I say it is resolved' })).status).toBe(403);
  });
  test('resolving requires a resolution note', async () => {
    expect((await off1.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'Resolved', note: 'short' })).status).toBe(400);
  });
  test('the officer resolves the complaint; resolved_at is set and the customer is notified', async () => {
    const res = await off1.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'Resolved', note: 'Duplicate charge reversed and confirmed with the bank.' });
    expect(res.status).toBe(200); expect(res.body.status).toBe('Resolved'); expect(res.body.resolved_at).toBeTruthy();
    expect(res.body.history.some((h) => h.update_type === 'Resolution')).toBe(true);
    const [rows] = await admin.query("SELECT * FROM notifications WHERE complaint_id = ? AND subject LIKE 'Complaint resolved%'", [complaint.complaint_id]); expect(rows).toHaveLength(1);
  });
  test('an officer cannot close a complaint manually', async () => {
    expect((await off1.post(`/api/complaints/${complaint.complaint_id}/status`).send({ status: 'Closed', note: 'closing' })).status).toBe(403);
  });
  test('feedback is only accepted from the owner and only for a resolved complaint', async () => {
    expect((await cust2.post(`/api/complaints/${complaint.complaint_id}/feedback`).send({ rating: 5 })).status).toBe(404);
    expect((await cust1.post(`/api/complaints/${complaint.complaint_id}/feedback`).send({ rating: 9 })).status).toBe(400);
    const pending = await cust1.post('/api/complaints').send(validComplaint(S.billing));
    expect((await cust1.post(`/api/complaints/${pending.body.complaint_id}/feedback`).send({ rating: 5 })).status).toBe(409);
  });
  test('feedback is stored and closes the complaint', async () => {
    const res = await cust1.post(`/api/complaints/${complaint.complaint_id}/feedback`).send({ rating: 4, comment: 'Quick resolution, thank you.' });
    expect(res.status).toBe(201); expect(res.body.status).toBe('Closed'); expect(res.body.closed_at).toBeTruthy(); expect(res.body.feedback.rating).toBe(4);
  });
  test('feedback cannot be given twice, and a closed complaint accepts no more messages', async () => {
    expect((await cust1.post(`/api/complaints/${complaint.complaint_id}/feedback`).send({ rating: 1 })).status).toBe(409);
    expect((await cust1.post(`/api/complaints/${complaint.complaint_id}/messages`).send({ message: 'One more thing' })).status).toBe(409);
  });
  test('a supervisor can close a resolved complaint manually', async () => {
    const r = await cust2.post('/api/complaints').send(validComplaint(S.billing));
    await sup.post(`/api/complaints/${r.body.complaint_id}/assign`).send({ officer_id: S.ids.off1 });
    await off1.post(`/api/complaints/${r.body.complaint_id}/status`).send({ status: 'In Progress' });
    await off1.post(`/api/complaints/${r.body.complaint_id}/status`).send({ status: 'Resolved', note: 'Resolved after contacting the customer.' });
    const res = await sup.post(`/api/complaints/${r.body.complaint_id}/status`).send({ status: 'Closed', note: 'Closed by supervisor' });
    expect(res.status).toBe(200); expect(res.body.status).toBe('Closed');
  });
  test('every step of the lifecycle appears in the audit trail', async () => {
    const [rows] = await admin.query('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY audit_id', [complaint.complaint_id]);
    const actions = rows.map((r) => r.action);
    for (const a of ['COMPLAINT_SUBMITTED', 'COMPLAINT_ASSIGNED', 'STATUS_IN_PROGRESS', 'STATUS_RESOLVED', 'FEEDBACK_SUBMITTED']) expect(actions).toContain(a);
  });
  test('two simultaneous status updates cannot both succeed (optimistic check)', async () => {
    const r = await cust2.post('/api/complaints').send(validComplaint(S.billing));
    await sup.post(`/api/complaints/${r.body.complaint_id}/assign`).send({ officer_id: S.ids.off1 });
    const results = await Promise.all([1, 2].map(() => off1.post(`/api/complaints/${r.body.complaint_id}/status`).send({ status: 'In Progress' })));
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
  });
});
