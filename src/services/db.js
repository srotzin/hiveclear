const { Pool } = require('pg');

// ---- In-memory fallback for Render free tier (no DATABASE_URL) ----
let useMemory = false;
let memTables = {};

function memInit() {
  useMemory = true;
  memTables = {
    validators: [],
    settlements: [],
    settlement_votes: [],
    reward_distributions: [],
    reward_balances: [],
    slashing_events: [],
    reward_pool: [{ id: 1, balance_usdc: 0, total_inflow_usdc: 0, total_distributed_usdc: 0, last_updated: new Date().toISOString() }],
    scout_pipeline: []
  };
  console.log('[HiveClear] DATABASE_URL not set — using in-memory store (data resets on restart)');
}

// ---- PostgreSQL pool (only if DATABASE_URL is set) ----
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    min: 2,
    max: 10,
    ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));
} else {
  memInit();
}

// ---- In-memory query shim ----
function memQuery(text, params = []) {
  const t = text.trim();

  // Transaction control — no-ops in memory
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(t)) return { rows: [], rowCount: 0 };

  const selectMatch = t.match(/FROM\s+(\w+)/i);
  const insertMatch = t.match(/INSERT INTO\s+(\w+)/i);
  const updateMatch = t.match(/UPDATE\s+(\w+)/i);
  const deleteMatch = t.match(/DELETE FROM\s+(\w+)/i);

  const tableName = (selectMatch || insertMatch || updateMatch || deleteMatch || [])[1];

  if (!tableName || !memTables[tableName]) {
    if (selectMatch && /COUNT|SUM|AVG|MAX|MIN/i.test(t)) {
      return { rows: [{ cnt: 0, total: 0, c: 0, id: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const table = memTables[tableName];

  // ── INSERT ──────────────────────────────────────────────────────────────────
  if (insertMatch) {
    const colMatch = t.match(/\(([^)]+)\)\s+VALUES/i);
    if (colMatch) {
      const cols = colMatch[1].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((col, i) => { row[col] = params[i] !== undefined ? params[i] : null; });
      if (/ON CONFLICT DO NOTHING/i.test(t)) {
        const firstCol = cols[0];
        if (table.some(r => r[firstCol] === row[firstCol])) return { rows: [], rowCount: 0 };
      }
      table.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────
  if (selectMatch) {
    let rows = [...table];
    const whereMatch = t.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch && params[parseInt(whereMatch[2]) - 1] !== undefined) {
      const col = whereMatch[1];
      const val = params[parseInt(whereMatch[2]) - 1];
      rows = rows.filter(r => String(r[col]) === String(val));
    }

    if (/COUNT\s*\(|SUM\s*\(|AVG\s*\(|MAX\s*\(|MIN\s*\(/i.test(t)) {
      const aggRow = {};
      const countAs = t.match(/COUNT\s*\(\*\)\s+as\s+(\w+)/i);
      if (countAs) aggRow[countAs[1]] = rows.length;
      const sumMatches = [...t.matchAll(/(?:COALESCE\s*\(\s*)?SUM\s*\((\w+)\)(?:\s*,\s*[^)]+\))?\s+as\s+(\w+)/gi)];
      sumMatches.forEach(m => {
        aggRow[m[2]] = rows.reduce((acc, r) => acc + (parseFloat(r[m[1]]) || 0), 0);
      });
      if (!countAs && /COUNT\s*\(\*\)/i.test(t)) aggRow.c = rows.length;
      return { rows: [aggRow], rowCount: 1 };
    }

    const limitMatch = t.match(/LIMIT\s+(\d+)/i);
    const orderMatch = t.match(/ORDER BY\s+(\w+)\s*(DESC|ASC)?/i);
    if (orderMatch) {
      const col = orderMatch[1], dir = (orderMatch[2] || 'ASC').toUpperCase();
      rows.sort((a, b) => {
        const av = parseFloat(a[col]) || 0, bv = parseFloat(b[col]) || 0;
        return dir === 'DESC' ? bv - av : av - bv;
      });
    }
    if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));
    return { rows, rowCount: rows.length };
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  if (updateMatch) {
    const whereMatch = t.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch) {
      const col = whereMatch[1], paramIdx = parseInt(whereMatch[2]) - 1;
      const setMatch = t.match(/SET\s+(.+?)\s+WHERE/is);
      if (setMatch) {
        const setPairs = setMatch[1].split(',').map(s => s.trim());
        table.forEach(row => {
          if (String(row[col]) === String(params[paramIdx])) {
            setPairs.forEach(pair => {
              const eqIdx = pair.indexOf('=');
              const k = pair.slice(0, eqIdx).trim();
              const v = pair.slice(eqIdx + 1).trim();
              const pIdx = parseInt((v.match(/\$(\d+)/) || [])[1]) - 1;
              if (!isNaN(pIdx) && params[pIdx] !== undefined) row[k] = params[pIdx];
            });
          }
        });
      }
    }
    return { rows: [], rowCount: 1 };
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  if (deleteMatch) {
    const whereMatch = t.match(/WHERE\s+(\w+)\s*=\s*\$1/i);
    if (whereMatch && params[0] !== undefined) {
      const col = whereMatch[1];
      const before = table.length;
      memTables[tableName] = table.filter(r => String(r[col]) !== String(params[0]));
      return { rows: [], rowCount: before - memTables[tableName].length };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
}

// ---- Public API ----
async function query(text, params) {
  if (useMemory) return memQuery(text, params);
  const res = await pool.query(text, params);
  return res;
}

async function getOne(text, params) {
  if (useMemory) { const r = memQuery(text, params); return r.rows[0] || null; }
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function getAll(text, params) {
  if (useMemory) return memQuery(text, params).rows;
  const res = await pool.query(text, params);
  return res.rows;
}

async function run(text, params) {
  if (useMemory) return memQuery(text, params);
  const res = await pool.query(text, params);
  return res;
}

async function getClient() {
  if (useMemory) {
    return {
      query: (text, params) => Promise.resolve(memQuery(text, params || [])),
      release: () => {}
    };
  }
  return pool.connect();
}

async function initializeSchema() {
  if (useMemory) return; // tables pre-initialized in memInit()
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

  const poolRow = await getOne('SELECT id FROM reward_pool WHERE id = 1');
  if (!poolRow) {
    await run(
      'INSERT INTO reward_pool (id, balance_usdc, total_inflow_usdc, total_distributed_usdc, last_updated) VALUES (1, 0, 0, 0, $1)',
      [new Date().toISOString()]
    );
  }
}

module.exports = { pool, query, getOne, getAll, run, getClient, initializeSchema };
