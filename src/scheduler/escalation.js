const cron = require('node-cron');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const audit = require('../services/auditService');
const { notify } = require('../services/notificationService');

// Algorithm 3.4: RunScheduledJobs
async function runScheduledJobs(now = new Date()) {
  const result = { escalated: 0, autoClosed: 0 };
  // Part A: escalation of overdue complaints (each complaint is escalated once)
  const [overdue] = await pool.execute(
    `SELECT complaint_id, reference_no, assigned_officer_id FROM complaints
      WHERE status IN ('Submitted','Assigned','In Progress') AND due_at < ? AND is_escalated = 0`, [now]);
  const [supervisors] = await pool.execute("SELECT user_id FROM users WHERE role = 'supervisor' AND is_active = 1");
  for (const c of overdue) {
    const done = await withTransaction(async (conn) => {
      const [r] = await conn.execute('UPDATE complaints SET is_escalated = 1, escalated_at = ? WHERE complaint_id = ? AND is_escalated = 0', [now, c.complaint_id]);
      if (!r.affectedRows) return false; // another run already escalated it
      await conn.execute("INSERT INTO complaint_updates (complaint_id, author_id, update_type, message, visible_to_customer) VALUES (?, NULL, 'Escalation', 'Complaint passed its due date', 0)", [c.complaint_id]);
      await audit.log(conn, { userId: null, action: 'COMPLAINT_ESCALATED', entityType: 'complaint', entityId: c.complaint_id });
      return true;
    });
    if (!done) continue;
    result.escalated++;
    for (const s of supervisors) await notify(s.user_id, c.complaint_id, `Escalated: ${c.reference_no}`, `Complaint ${c.reference_no} has passed its due date.`);
    if (c.assigned_officer_id) await notify(c.assigned_officer_id, c.complaint_id, `Overdue: ${c.reference_no}`, `Complaint ${c.reference_no} has passed its due date.`);
  }
  // Part B: automatic closure of resolved complaints with no customer response
  const cutoff = new Date(now.getTime() - config.autoCloseDays * 86400 * 1000);
  const [stale] = await pool.execute("SELECT complaint_id FROM complaints WHERE status = 'Resolved' AND resolved_at < ?", [cutoff]);
  for (const c of stale) {
    const done = await withTransaction(async (conn) => {
      const [r] = await conn.execute("UPDATE complaints SET status = 'Closed', closed_at = ? WHERE complaint_id = ? AND status = 'Resolved'", [now, c.complaint_id]);
      if (!r.affectedRows) return false;
      await audit.log(conn, { userId: null, action: 'COMPLAINT_AUTO_CLOSED', entityType: 'complaint', entityId: c.complaint_id });
      return true;
    });
    if (done) result.autoClosed++;
  }
  return result;
}

function start() {
  let running = false;
  return cron.schedule(config.escalationCron, async () => {
    if (running) return; running = true;
    try { await runScheduledJobs(); } catch (e) { console.error('Scheduled job failed:', e.message); } finally { running = false; }
  });
}

module.exports = { runScheduledJobs, start };
