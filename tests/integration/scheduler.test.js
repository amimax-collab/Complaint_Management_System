const { admin, resetDb, seedBasic, insertComplaint } = require('../helpers');
const { pool } = require('../../src/db');
const { runScheduledJobs } = require('../../src/scheduler/escalation');

const HOUR = 3600000, DAY = 24 * HOUR;
let S;
beforeEach(async () => { await resetDb(); S = await seedBasic(); });
afterAll(async () => { await admin.end(); await pool.end(); });

const base = () => ({ customer_id: S.ids.cust1, category_id: S.billing });
const get = async (id) => (await admin.query('SELECT * FROM complaints WHERE complaint_id = ?', [id]))[0][0];

describe('Algorithm 3.4, Part A: escalation of overdue complaints', () => {
  test('an overdue open complaint is escalated, flagged and logged', async () => {
    const id = await insertComplaint({ ...base(), status: 'In Progress', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - 2 * HOUR) });
    const r = await runScheduledJobs();
    expect(r.escalated).toBe(1);
    const c = await get(id); expect(c.is_escalated).toBe(1); expect(c.escalated_at).toBeTruthy(); expect(c.status).toBe('In Progress'); expect(c.assigned_officer_id).toBe(S.ids.off1);
    const [upd] = await admin.query("SELECT * FROM complaint_updates WHERE complaint_id = ? AND update_type = 'Escalation'", [id]);
    expect(upd).toHaveLength(1); expect(upd[0].author_id).toBeNull(); expect(upd[0].visible_to_customer).toBe(0);
    const [aud] = await admin.query("SELECT * FROM audit_log WHERE action = 'COMPLAINT_ESCALATED' AND entity_id = ?", [id]);
    expect(aud).toHaveLength(1); expect(aud[0].user_id).toBeNull(); // null user marks a system action
  });
  test('the supervisors and the assigned officer are notified', async () => {
    const id = await insertComplaint({ ...base(), status: 'Assigned', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - HOUR) });
    await runScheduledJobs();
    const [n] = await admin.query('SELECT user_id, subject FROM notifications WHERE complaint_id = ?', [id]);
    expect(n.map((x) => x.user_id).sort()).toEqual([S.ids.sup, S.ids.off1].sort());
    expect(n.find((x) => x.user_id === S.ids.sup).subject).toMatch(/^Escalated:/); expect(n.find((x) => x.user_id === S.ids.off1).subject).toMatch(/^Overdue:/);
  });
  test('an unassigned overdue complaint is escalated and only supervisors are notified', async () => {
    const id = await insertComplaint({ ...base(), status: 'Submitted', due_at: new Date(Date.now() - HOUR) });
    await runScheduledJobs();
    expect((await get(id)).is_escalated).toBe(1);
    const [n] = await admin.query('SELECT user_id FROM notifications WHERE complaint_id = ?', [id]); expect(n.map((x) => x.user_id)).toEqual([S.ids.sup]);
  });
  test('each complaint is escalated only once, however often the job runs', async () => {
    await insertComplaint({ ...base(), status: 'In Progress', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - HOUR) });
    expect((await runScheduledJobs()).escalated).toBe(1); expect((await runScheduledJobs()).escalated).toBe(0);
    const [[{ n }]] = await admin.query("SELECT COUNT(*) n FROM notifications"); expect(n).toBe(2); // one supervisor + one officer, not repeated
  });
  test('two overlapping runs escalate a complaint exactly once', async () => {
    const id = await insertComplaint({ ...base(), status: 'Assigned', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - HOUR) });
    const [a, b] = await Promise.all([runScheduledJobs(), runScheduledJobs()]);
    expect(a.escalated + b.escalated).toBe(1);
    const [aud] = await admin.query("SELECT * FROM audit_log WHERE action = 'COMPLAINT_ESCALATED' AND entity_id = ?", [id]); expect(aud).toHaveLength(1);
  });
  test('complaints that are not yet due, resolved or closed are not escalated', async () => {
    const future = await insertComplaint({ ...base(), status: 'In Progress', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() + 5 * HOUR) });
    const resolved = await insertComplaint({ ...base(), status: 'Resolved', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - 5 * HOUR), resolved_at: new Date() });
    const closed = await insertComplaint({ ...base(), status: 'Closed', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - 5 * HOUR), resolved_at: new Date(), closed_at: new Date() });
    expect((await runScheduledJobs()).escalated).toBe(0);
    for (const id of [future, resolved, closed]) expect((await get(id)).is_escalated).toBe(0);
  });
  test('the job can be run for a chosen point in time', async () => {
    const id = await insertComplaint({ ...base(), status: 'In Progress', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() + 2 * DAY) });
    expect((await runScheduledJobs(new Date(Date.now() + 3 * DAY))).escalated).toBe(1); expect((await get(id)).is_escalated).toBe(1);
  });
});

describe('Algorithm 3.4, Part B: automatic closure', () => {
  test('a complaint resolved more than the configured period ago is closed', async () => {
    const id = await insertComplaint({ ...base(), status: 'Resolved', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() + DAY), resolved_at: new Date(Date.now() - 8 * DAY) });
    const r = await runScheduledJobs();
    expect(r.autoClosed).toBe(1); const c = await get(id); expect(c.status).toBe('Closed'); expect(c.closed_at).toBeTruthy();
    const [aud] = await admin.query("SELECT user_id FROM audit_log WHERE action = 'COMPLAINT_AUTO_CLOSED' AND entity_id = ?", [id]); expect(aud).toHaveLength(1); expect(aud[0].user_id).toBeNull();
  });
  test('a recently resolved complaint stays open for feedback', async () => {
    const id = await insertComplaint({ ...base(), status: 'Resolved', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() + DAY), resolved_at: new Date(Date.now() - 2 * DAY) });
    expect((await runScheduledJobs()).autoClosed).toBe(0); expect((await get(id)).status).toBe('Resolved');
  });
  test('a resolved complaint is not escalated even when it was resolved late', async () => {
    await insertComplaint({ ...base(), status: 'Resolved', assigned_officer_id: S.ids.off1, due_at: new Date(Date.now() - 3 * DAY), resolved_at: new Date(Date.now() - 2 * DAY) });
    expect((await runScheduledJobs()).escalated).toBe(0);
  });
});
