const { pool } = require('../db');

// Query 3.1: complaints, escalations and average resolution time per category
async function byCategory(from, to) {
  const [rows] = await pool.execute(
    `SELECT cat.category_name, COUNT(*) AS total_complaints, SUM(k.is_escalated) AS escalated,
            AVG(TIMESTAMPDIFF(HOUR, k.submitted_at, k.resolved_at)) AS avg_resolution_hours
       FROM complaints k JOIN categories cat ON cat.category_id = k.category_id
      WHERE k.submitted_at BETWEEN ? AND ? GROUP BY cat.category_name ORDER BY total_complaints DESC`, [from, to]);
  return rows.map((r) => ({ ...r, total_complaints: Number(r.total_complaints), escalated: Number(r.escalated), avg_resolution_hours: r.avg_resolution_hours == null ? null : Number(Number(r.avg_resolution_hours).toFixed(1)) }));
}

async function byStatus(from, to) {
  const [rows] = await pool.execute('SELECT status, COUNT(*) AS total FROM complaints WHERE submitted_at BETWEEN ? AND ? GROUP BY status', [from, to]);
  return rows.map((r) => ({ status: r.status, total: Number(r.total) }));
}

async function ratingByCategory(from, to) {
  const [rows] = await pool.execute(
    `SELECT cat.category_name, COUNT(f.feedback_id) AS responses, AVG(f.rating) AS avg_rating
       FROM feedback f JOIN complaints k ON k.complaint_id = f.complaint_id JOIN categories cat ON cat.category_id = k.category_id
      WHERE k.submitted_at BETWEEN ? AND ? GROUP BY cat.category_name ORDER BY cat.category_name`, [from, to]);
  return rows.map((r) => ({ category_name: r.category_name, responses: Number(r.responses), avg_rating: Number(Number(r.avg_rating).toFixed(2)) }));
}

async function officerWorkload() {
  const [rows] = await pool.execute(
    `SELECT u.user_id, u.full_name, COUNT(c.complaint_id) AS open_complaints
       FROM users u LEFT JOIN complaints c ON c.assigned_officer_id = u.user_id AND c.status IN ('Assigned', 'In Progress')
      WHERE u.role = 'officer' GROUP BY u.user_id, u.full_name ORDER BY open_complaints DESC, u.user_id`);
  return rows.map((r) => ({ ...r, open_complaints: Number(r.open_complaints) }));
}

async function summary(from, to) {
  const [cat, st, rt, wl] = await Promise.all([byCategory(from, to), byStatus(from, to), ratingByCategory(from, to), officerWorkload()]);
  return { by_category: cat, by_status: st, rating_by_category: rt, officer_workload: wl };
}

module.exports = { summary, byCategory, byStatus, ratingByCategory, officerWorkload };
