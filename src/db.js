const mysql = require('mysql2/promise');
const config = require('./config');

function makePool(user, password) {
  const pool = mysql.createPool({
    host: config.db.host, user, password, database: config.db.database,
    waitForConnections: true, connectionLimit: config.db.poolSize,
    timezone: 'Z', dateStrings: false, charset: 'utf8mb4',
  });
  // All timestamps are stored and handled in UTC (design assumption, Section 3.1.2)
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
  return pool;
}

const pool = makePool(config.db.user, config.db.password);

async function withTransaction(fn, p = pool) {
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, makePool, withTransaction };
