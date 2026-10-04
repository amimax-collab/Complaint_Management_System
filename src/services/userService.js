const argon2 = require('argon2');
const { pool } = require('../db');
const { HttpError } = require('../errors');
const audit = require('./auditService');
const v = require('../middleware/validate');

let dummyHash = null; // verified when the e-mail is unknown so response time does not reveal which case occurred
async function getDummyHash() { if (!dummyHash) dummyHash = await argon2.hash('dummy-password-for-timing'); return dummyHash; }

const publicUser = (u) => ({ user_id: u.user_id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role, is_active: !!u.is_active, created_at: u.created_at, last_login_at: u.last_login_at });

async function createUser(input, role, ip, actorId = null) {
  const hash = await argon2.hash(input.password); // Argon2id by default
  try {
    const [r] = await pool.execute('INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [input.full_name, input.email, input.phone, hash, role]);
    await audit.log(null, { userId: actorId || r.insertId, action: actorId ? 'USER_CREATED' : 'USER_REGISTERED', entityType: 'user', entityId: r.insertId, details: { role }, ip });
    const [[u]] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [r.insertId]);
    return publicUser(u);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An account with this e-mail address already exists');
    throw e;
  }
}

const register = (body, ip) => createUser(v.validateRegistration(body), 'customer', ip);
const adminCreate = (body, actorId, ip) => { const x = v.validateUserCreate(body); return createUser(x, x.role, ip, actorId); };

// Algorithm 3.5: Login
async function login(email, password, ip) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(e) || typeof password !== 'string' || password.length === 0) throw new HttpError(400, 'E-mail and password are required');
  const [[user]] = await pool.execute('SELECT * FROM users WHERE email = ?', [e]);
  const hash = user ? user.password_hash : await getDummyHash();
  const ok = await argon2.verify(hash, password).catch(() => false);
  if (!user || !ok || !user.is_active) {
    await audit.log(null, { userId: user ? user.user_id : null, action: 'LOGIN_FAILED', entityType: 'user', entityId: user ? user.user_id : null, details: { email: e.slice(0, 120) }, ip });
    throw new HttpError(401, 'Invalid e-mail or password');
  }
  await pool.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE user_id = ?', [user.user_id]);
  await audit.log(null, { userId: user.user_id, action: 'LOGIN_SUCCESS', entityType: 'user', entityId: user.user_id, ip });
  return publicUser(user);
}

async function list({ role } = {}) {
  const [rows] = role ? await pool.execute('SELECT * FROM users WHERE role = ? ORDER BY user_id', [role]) : await pool.execute('SELECT * FROM users ORDER BY user_id LIMIT 1000');
  return rows.map(publicUser);
}

async function patch(id, body, actor, ip) {
  const changes = v.validateUserPatch(body);
  if (id === actor.userId && (changes.is_active === 0 || (changes.role && changes.role !== actor.role))) throw new HttpError(409, 'You cannot deactivate or change the role of your own account');
  const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
  const [r] = await pool.execute(`UPDATE users SET ${sets} WHERE user_id = ?`, [...Object.values(changes), id]);
  if (!r.affectedRows) throw new HttpError(404, 'User not found');
  await audit.log(null, { userId: actor.userId, action: 'USER_UPDATED', entityType: 'user', entityId: id, details: changes, ip });
  const [[u]] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [id]);
  return publicUser(u);
}

module.exports = { register, adminCreate, login, list, patch };
