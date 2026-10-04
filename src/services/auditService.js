const { pool } = require('../db');

async function log(conn, { userId = null, action, entityType = null, entityId = null, details = null, ip = null }) {
  const c = conn || pool;
  await c.execute(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, entityType, entityId, details ? JSON.stringify(details) : null, ip]
  );
}

async function search({ userId, entityType, entityId, action, from, to, limit = 100 }) {
  const where = []; const params = [];
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const sql = `SELECT audit_id, user_id, action, entity_type, entity_id, details, ip_address, created_at FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY audit_id DESC LIMIT ${lim}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = { log, search };
