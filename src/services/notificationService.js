const nodemailer = require('nodemailer');
const config = require('../config');
const { pool } = require('../db');

function buildTransport() {
  if (config.smtp.host) {
    return nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
  }
  return nodemailer.createTransport({ jsonTransport: true }); // development/testing: messages are built but not sent
}
let transport = buildTransport();
function setTransport(t) { transport = t || buildTransport(); }

// Records a notification, then tries to send it. Delivery failure never blocks the workflow.
async function notify(userId, complaintId, subject, message) {
  let id = null;
  try {
    const [[user]] = await pool.execute('SELECT email FROM users WHERE user_id = ?', [userId]);
    if (!user) return null;
    const [ins] = await pool.execute(
      "INSERT INTO notifications (user_id, complaint_id, subject, message, delivery_status) VALUES (?, ?, ?, ?, 'Pending')",
      [userId, complaintId, subject.slice(0, 150), message]);
    id = ins.insertId;
    try {
      await transport.sendMail({ from: config.mailFrom, to: user.email, subject, text: message });
      await pool.execute("UPDATE notifications SET delivery_status = 'Sent', sent_at = UTC_TIMESTAMP() WHERE notification_id = ?", [id]);
    } catch {
      await pool.execute("UPDATE notifications SET delivery_status = 'Failed' WHERE notification_id = ?", [id]);
    }
  } catch { /* notification problems must not break the complaint workflow */ }
  return id;
}

async function listForUser(userId, limit = 50) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const [rows] = await pool.execute(
    `SELECT notification_id, complaint_id, subject, message, delivery_status, sent_at FROM notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT ${lim}`, [userId]);
  return rows;
}

module.exports = { notify, listForUser, setTransport };
