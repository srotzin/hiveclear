const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 2,
  max: 10,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

// Async helpers
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function getOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function getAll(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function run(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function getClient() {
  return pool.connect();
}

// Initialize schema — called on startup
async function initializeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS validators (
      did TEXT PRIMARY KEY,
      voting_power NUMERIC DEFAULT 1,
      bond_amount_usdc NUMERIC DEFAULT 0,
      reputation_at_enrollment NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      enrolled_at TEXT,
      withdrawal_initiated_at TEXT,
      cooldown_until TEXT,
      uptime_pct NUMERIC DEFAULT 100,
      blocks_validated INTEGER DEFAULT 0,
      total_earned_usdc NUMERIC DEFAULT 0,
      last_heartbeat TEXT
    );

    CREATE TABLE IF NOT EXISTS settlements (
      settlement_id TEXT PRIMARY KEY,
      transaction_id TEXT,
      from_did TEXT NOT NULL,
      to_did TEXT NOT NULL,
      amount_usdc NUMERIC NOT NULL,
      fee_usdc NUMERIC DEFAULT 0,
      service TEXT,
      memo TEXT,
      status TEXT DEFAULT 'pending',
      votes_for NUMERIC DEFAULT 0,
      votes_against NUMERIC DEFAULT 0,
      votes_abstain NUMERIC DEFAULT 0,
      total_voting_power NUMERIC DEFAULT 0,
      threshold_met INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      created_at TEXT,
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settlement_votes (
      id SERIAL PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      validator_did TEXT NOT NULL,
      vote TEXT NOT NULL,
      reason TEXT,
      voted_at TEXT,
      UNIQUE(settlement_id, validator_did)
    );

    CREATE TABLE IF NOT EXISTS reward_distributions (
      distribution_id TEXT PRIMARY KEY,
      total_distributed_usdc NUMERIC,
      validators_paid INTEGER,
      distribution_details TEXT,
      distributed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reward_balances (
      did TEXT PRIMARY KEY,
      total_earned_usdc NUMERIC DEFAULT 0,
      pending_usdc NUMERIC DEFAULT 0,
      last_distribution_at TEXT
    );

    CREATE TABLE IF NOT EXISTS slashing_events (
      slash_id TEXT PRIMARY KEY,
      validator_did TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT,
      amount_slashed_usdc NUMERIC,
      hivelaw_case_id TEXT,
      slashed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reward_pool (
      id INTEGER PRIMARY KEY DEFAULT 1,
      balance_usdc NUMERIC DEFAULT 0,
      total_inflow_usdc NUMERIC DEFAULT 0,
      total_distributed_usdc NUMERIC DEFAULT 0,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS scout_pipeline (
      did TEXT PRIMARY KEY,
      reputation NUMERIC,
      bond_amount NUMERIC,
      age_days INTEGER,
      eligible INTEGER,
      outreach_sent INTEGER DEFAULT 0,
      bounty_id TEXT,
      enrolled INTEGER DEFAULT 0,
      scanned_at TEXT
    );
  `);

  // Initialize reward pool if empty
  const poolRow = await getOne('SELECT id FROM reward_pool WHERE id = 1');
  if (!poolRow) {
    await run(
      'INSERT INTO reward_pool (id, balance_usdc, total_inflow_usdc, total_distributed_usdc, last_updated) VALUES (1, 0, 0, 0, $1)',
      [new Date().toISOString()]
    );
  }
}

module.exports = {
  pool,
  query,
  getOne,
  getAll,
  run,
  getClient,
  initializeSchema,
};
