const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'hiveclear.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS validators (
    did TEXT PRIMARY KEY,
    voting_power REAL DEFAULT 1,
    bond_amount_usdc REAL DEFAULT 0,
    reputation_at_enrollment REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    enrolled_at TEXT,
    withdrawal_initiated_at TEXT,
    cooldown_until TEXT,
    uptime_pct REAL DEFAULT 100,
    blocks_validated INTEGER DEFAULT 0,
    total_earned_usdc REAL DEFAULT 0,
    last_heartbeat TEXT
  );

  CREATE TABLE IF NOT EXISTS settlements (
    settlement_id TEXT PRIMARY KEY,
    transaction_id TEXT,
    from_did TEXT NOT NULL,
    to_did TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    fee_usdc REAL DEFAULT 0,
    service TEXT,
    memo TEXT,
    status TEXT DEFAULT 'pending',
    votes_for REAL DEFAULT 0,
    votes_against REAL DEFAULT 0,
    votes_abstain REAL DEFAULT 0,
    total_voting_power REAL DEFAULT 0,
    threshold_met INTEGER DEFAULT 0,
    created_at TEXT,
    settled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settlement_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id TEXT NOT NULL,
    validator_did TEXT NOT NULL,
    vote TEXT NOT NULL,
    reason TEXT,
    voted_at TEXT,
    UNIQUE(settlement_id, validator_did)
  );

  CREATE TABLE IF NOT EXISTS reward_distributions (
    distribution_id TEXT PRIMARY KEY,
    total_distributed_usdc REAL,
    validators_paid INTEGER,
    distribution_details TEXT,
    distributed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS reward_balances (
    did TEXT PRIMARY KEY,
    total_earned_usdc REAL DEFAULT 0,
    pending_usdc REAL DEFAULT 0,
    last_distribution_at TEXT
  );

  CREATE TABLE IF NOT EXISTS slashing_events (
    slash_id TEXT PRIMARY KEY,
    validator_did TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT,
    amount_slashed_usdc REAL,
    hivelaw_case_id TEXT,
    slashed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS reward_pool (
    id INTEGER PRIMARY KEY DEFAULT 1,
    balance_usdc REAL DEFAULT 0,
    total_inflow_usdc REAL DEFAULT 0,
    total_distributed_usdc REAL DEFAULT 0,
    last_updated TEXT
  );

  CREATE TABLE IF NOT EXISTS scout_pipeline (
    did TEXT PRIMARY KEY,
    reputation REAL,
    bond_amount REAL,
    age_days INTEGER,
    eligible INTEGER,
    outreach_sent INTEGER DEFAULT 0,
    bounty_id TEXT,
    enrolled INTEGER DEFAULT 0,
    scanned_at TEXT
  );
`);

// Initialize reward pool if empty
const poolRow = db.prepare('SELECT id FROM reward_pool WHERE id = 1').get();
if (!poolRow) {
  db.prepare('INSERT INTO reward_pool (id, balance_usdc, total_inflow_usdc, total_distributed_usdc, last_updated) VALUES (1, 0, 0, 0, ?)').run(new Date().toISOString());
}

module.exports = db;
