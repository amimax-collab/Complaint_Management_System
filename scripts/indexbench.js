// Times the principal queries with and without their index (IGNORE INDEX forces a table scan) and records EXPLAIN output.
// Usage: node scripts/indexbench.js [outputFile]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { performance } = require('perf_hooks');
const { pool } = require('../src/db');

async function time(sql, params, reps = 200) {
  for (let i = 0; i < 10; i++) await pool.query(sql, params);
  const t = []; let rows = 0;
  for (let i = 0; i < reps; i++) { const t0 = performance.now(); const [r] = await pool.query(sql, params); t.push(performance.now() - t0); rows = r.length; }
  t.sort((a, b) => a - b); return { mean: t.reduce((a, b) => a + b, 0) / t.length, median: t[Math.floor(t.length / 2)], rows };
}
async function explain(sql, params) {
  const [r] = await pool.query('EXPLAIN FORMAT=JSON ' + sql, params); const j = JSON.parse(r[0].EXPLAIN); const tbl = j.query_block.table || (j.query_block.ordering_operation && j.query_block.ordering_operation.table) || {};
  return { access_type: tbl.access_type, key: tbl.key || null, rows_examined: tbl.rows_examined_per_scan };
}
async function main() {
  const [[ref]] = await pool.query('SELECT reference_no FROM complaints ORDER BY complaint_id DESC LIMIT 1 OFFSET 100');
  const [[cu]] = await pool.query("SELECT customer_id, COUNT(*) n FROM complaints GROUP BY customer_id ORDER BY n DESC LIMIT 1");
  const [[ofc]] = await pool.query('SELECT assigned_officer_id id FROM complaints WHERE assigned_officer_id IS NOT NULL LIMIT 1');
  const [[hc]] = await pool.query('SELECT complaint_id FROM complaints ORDER BY complaint_id DESC LIMIT 1 OFFSET 50');
  const now = new Date();
  const cases = [
    ['Track by reference number', 'idx: uq_complaints_reference', 'SELECT * FROM complaints {IGN} WHERE reference_no = ?', [ref.reference_no], 'uq_complaints_reference'],
    ['Overdue complaints (Algorithm 3.4)', 'idx: idx_complaints_due', "SELECT complaint_id, reference_no, assigned_officer_id FROM complaints {IGN} WHERE status IN ('Submitted','Assigned','In Progress') AND due_at < ? AND is_escalated = 0", [now], 'idx_complaints_due'],
    ["A customer's complaints", 'idx: idx_complaints_customer', 'SELECT complaint_id, reference_no, status, due_at FROM complaints {IGN} WHERE customer_id = ? ORDER BY submitted_at DESC LIMIT 25', [cu.customer_id], 'idx_complaints_customer'],
    ["Officer's open complaints", 'idx: idx_complaints_officer', "SELECT complaint_id, status, due_at FROM complaints {IGN} WHERE assigned_officer_id = ? AND status IN ('Assigned','In Progress') ORDER BY due_at", [ofc.id], 'idx_complaints_officer'],
    ['Complaint history', 'idx: idx_updates_complaint', 'SELECT update_id, update_type, message, created_at FROM complaint_updates {IGN} WHERE complaint_id = ? ORDER BY created_at, update_id', [hc.complaint_id], 'idx_updates_complaint'],
  ];
  const out = { db: process.env.DB_NAME || 'complaint_mgmt_db', cases: [] };
  const [[c]] = await pool.query('SELECT (SELECT COUNT(*) FROM complaints) complaints, (SELECT COUNT(*) FROM complaint_updates) updates'); out.counts = c;
  for (const [name, , sql, params, idx] of cases) {
    const table = sql.includes('complaint_updates') ? 'complaint_updates' : 'complaints';
    const withIdx = sql.replace('{IGN} ', ''), noIdx = sql.replace('{IGN}', `IGNORE INDEX (${idx})`).replace(/IGNORE INDEX \(([^)]+)\)/, (m) => m);
    const a = await time(withIdx, params), b = await time(noIdx, params);
    const ea = await explain(withIdx, params), eb = await explain(noIdx, params);
    const row = { name, index: idx, rows_returned: a.rows, with_index_ms: Math.round(a.mean * 1000) / 1000, without_index_ms: Math.round(b.mean * 1000) / 1000, speedup: Math.round((b.mean / a.mean) * 10) / 10, explain_with: ea, explain_without: eb };
    console.log(name.padEnd(36), JSON.stringify({ rows: row.rows_returned, with: row.with_index_ms, without: row.without_index_ms, speedup: row.speedup, plan_with: ea.access_type + '/' + ea.key, plan_without: eb.access_type + '/' + eb.key }));
    out.cases.push(row);
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
