const { pool, withTransaction } = require('../db');
const { HttpError } = require('../errors');
const { authorized } = require('../middleware/rbac');
const audit = require('./auditService');
const { notify } = require('./notificationService');
const complaints = require('./complaintService');

// SuggestOfficer (Algorithm 3.2): active officer with the fewest open complaints, ties by lowest id
async function suggestOfficer() {
  const [rows] = await pool.execute(
    `SELECT u.user_id, u.full_name, COUNT(c.complaint_id) AS open_count
       FROM users u LEFT JOIN complaints c ON c.assigned_officer_id = u.user_id AND c.status IN ('Assigned', 'In Progress')
      WHERE u.role = 'officer' AND u.is_active = 1
      GROUP BY u.user_id, u.full_name ORDER BY open_count ASC, u.user_id ASC LIMIT 1`);
  return rows[0] || null;
}

async function officersWithWorkload() {
  const [rows] = await pool.execute(
    `SELECT u.user_id, u.full_name, COUNT(c.complaint_id) AS open_count
       FROM users u LEFT JOIN complaints c ON c.assigned_officer_id = u.user_id AND c.status IN ('Assigned', 'In Progress')
      WHERE u.role = 'officer' AND u.is_active = 1 GROUP BY u.user_id, u.full_name ORDER BY open_count ASC, u.user_id ASC`);
  return rows;
}

// Algorithm 3.2: AssignComplaint
async function assign(user, id, officerId, ip) {
  if (!authorized(user, 'assign_complaint')) throw new HttpError(403, 'Forbidden');
  const c = await complaints.getRaw(id);
  if (!c) throw new HttpError(404, 'Complaint not found');
  if (['Resolved', 'Closed'].includes(c.status)) throw new HttpError(409, 'Complaint cannot be assigned');
  let chosen = officerId;
  if (chosen == null) {
    const s = await suggestOfficer();
    if (!s) throw new HttpError(409, 'There is no active officer to assign the complaint to');
    chosen = s.user_id;
  } else {
    const [[o]] = await pool.execute("SELECT user_id FROM users WHERE user_id = ? AND role = 'officer' AND is_active = 1", [chosen]);
    if (!o) throw new HttpError(400, 'Invalid officer');
  }
  await withTransaction(async (conn) => {
    await conn.execute("UPDATE complaints SET assigned_officer_id = ?, status = IF(status = 'Submitted', 'Assigned', status) WHERE complaint_id = ?", [chosen, id]);
    await conn.execute("INSERT INTO complaint_updates (complaint_id, author_id, update_type, message, visible_to_customer) VALUES (?, ?, 'Assignment', ?, 0)",
      [id, user.userId, `Assigned to officer ${chosen}`]);
    await audit.log(conn, { userId: user.userId, action: 'COMPLAINT_ASSIGNED', entityType: 'complaint', entityId: id, details: { officer_id: chosen }, ip });
  });
  await notify(chosen, id, `New complaint assigned: ${c.reference_no}`, `Complaint ${c.reference_no} has been assigned to you.`);
  await notify(c.customer_id, id, `Your complaint is being handled: ${c.reference_no}`, `Complaint ${c.reference_no} has been assigned to an officer.`);
  return complaints.getDetail(user, id);
}

module.exports = { assign, suggestOfficer, officersWithWorkload };
