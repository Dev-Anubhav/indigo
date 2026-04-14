'use strict';

const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './data/jobs.db';

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(path.resolve(DB_PATH));
  _db.pragma('journal_mode = WAL');  // faster writes, crash-safe
  _db.pragma('synchronous = NORMAL');
  initSchema(_db);
  ensureColumns(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pnr           TEXT NOT NULL,
      last_name     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      -- status values: pending | processing | done | failed | retry
      retry_count   INTEGER NOT NULL DEFAULT 0,
      
      -- extracted fields
      passenger_name    TEXT,
      flight_number     TEXT,
      origin            TEXT,
      destination       TEXT,
      travel_date       TEXT,
      departure_time    TEXT,
      arrival_time      TEXT,
      booking_status    TEXT,
      lift_status       TEXT,
      refund_amount     TEXT,
      refund_status     TEXT,
      seat_number       TEXT,
      fare_amount       TEXT,
      raw_json          TEXT,   -- full raw response for debugging
      error_msg         TEXT,
      
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_attempted_at DATETIME,
      completed_at      DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_pnr    ON jobs(pnr);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pnr_last_name_unique ON jobs(pnr, last_name);

    CREATE TABLE IF NOT EXISTS run_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event      TEXT,
      detail     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function ensureColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name);
  if (!cols.includes('lift_status')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN lift_status TEXT`);
  }
  if (!cols.includes('refund_amount')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN refund_amount TEXT`);
  }
  if (!cols.includes('refund_status')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN refund_status TEXT`);
  }
}

// ─── Job operations ─────────────────────────────────────────────────────────────

function insertJobs(rows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs (pnr, last_name)
    VALUES (@pnr, @last_name)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });
  insertMany(rows);
}

function getNextBatch(limit) {
  const db = getDb();
  // Pick pending jobs, or retry jobs that haven't been attempted recently
  return db.prepare(`
    SELECT * FROM jobs
    WHERE status IN ('pending', 'retry')
    AND retry_count < ?
    ORDER BY id ASC
    LIMIT ?
  `).all(parseInt(process.env.MAX_RETRIES || 3), limit);
}

function markProcessing(id) {
  getDb().prepare(`
    UPDATE jobs SET status = 'processing', last_attempted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

function markDone(id, data) {
  getDb().prepare(`
    UPDATE jobs SET
      status         = 'done',
      passenger_name = @passenger_name,
      flight_number  = @flight_number,
      origin         = @origin,
      destination    = @destination,
      travel_date    = @travel_date,
      departure_time = @departure_time,
      arrival_time   = @arrival_time,
      booking_status = @booking_status,
      lift_status    = @lift_status,
      seat_number    = @seat_number,
      fare_amount    = @fare_amount,
      raw_json       = @raw_json,
      error_msg      = NULL,
      completed_at   = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id, ...data });
}

function markRefundDone(id, data) {
  getDb().prepare(`
    UPDATE jobs SET
      status         = 'done',
      refund_amount  = @refund_amount,
      refund_status  = @refund_status,
      raw_json       = @raw_json,
      error_msg      = NULL,
      completed_at   = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id, ...data });
}

function markFailed(id, errorMsg, canRetry = true) {
  const db = getDb();
  const job = db.prepare('SELECT retry_count FROM jobs WHERE id = ?').get(id);
  const maxRetries = parseInt(process.env.MAX_RETRIES || 3);
  const newCount = (job?.retry_count || 0) + 1;
  const newStatus = (canRetry && newCount < maxRetries) ? 'retry' : 'failed';

  db.prepare(`
    UPDATE jobs SET
      status        = ?,
      retry_count   = ?,
      error_msg     = ?,
      last_attempted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, newCount, errorMsg, id);
}

// Recovery: any job stuck in 'processing' for >10 min is reset (crash recovery)
function recoverStuckJobs() {
  const result = getDb().prepare(`
    UPDATE jobs SET status = 'retry'
    WHERE status = 'processing'
    AND last_attempted_at < datetime('now', '-10 minutes')
  `).run();
  return result.changes;
}

function getStats() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM jobs GROUP BY status
  `).all();
  const stats = { pending: 0, processing: 0, done: 0, failed: 0, retry: 0, total: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }
  return stats;
}

function getAllDone() {
  return getDb().prepare(`
    SELECT * FROM jobs WHERE status = 'done' ORDER BY id ASC
  `).all();
}

function getAllFailed() {
  return getDb().prepare(`
    SELECT * FROM jobs WHERE status = 'failed' ORDER BY id ASC
  `).all();
}

function resetFailedToPending() {
  return getDb().prepare(`
    UPDATE jobs SET status = 'pending', retry_count = 0, error_msg = NULL
    WHERE status = 'failed'
  `).run().changes;
}

function logEvent(event, detail) {
  getDb().prepare(`
    INSERT INTO run_log (event, detail) VALUES (?, ?)
  `).run(event, detail);
}

module.exports = {
  getDb,
  insertJobs,
  getNextBatch,
  markProcessing,
  markDone,
  markRefundDone,
  markFailed,
  recoverStuckJobs,
  getStats,
  getAllDone,
  getAllFailed,
  resetFailedToPending,
  logEvent,
};
