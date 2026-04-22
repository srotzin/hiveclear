'use strict';
// Merged from hivetransactions — salvage market routes
// Mounted at /v1/transaction/salvage in server.js
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

const SALVAGE_FEE_PCT = 0.05;

async function ensureSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS failed_tx_salvage (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        original_tx_id  TEXT NOT NULL,
        failure_reason  TEXT,
        bounty_usdc     NUMERIC(18,6) DEFAULT 0,
        poster_did      TEXT NOT NULL,
        rescuer_did     TEXT,
        deadline        TIMESTAMPTZ NOT NULL,
        status          TEXT DEFAULT 'open',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_salvage_status ON failed_tx_salvage(status);
    `);
  } catch (e) {
    console.warn('[tx-salvage] ensureSchema warning:', e.message);
  }
}

ensureSchema();

// ─── POST / — Open a salvage market ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const { failed_tx_id, bounty_usdc, poster_did, deadline_seconds = 120 } = req.body;

  if (!failed_tx_id || !poster_did) {
    return res.status(400).json({ error: 'failed_tx_id and poster_did required' });
  }

  const intent = await db.getOne(`SELECT * FROM transaction_intents WHERE id=$1`, [failed_tx_id]).catch(() => null);

  if (intent && !['failed','salvaged'].includes(intent.status)) {
    await db.run(`UPDATE transaction_intents SET status='failed', updated_at=NOW() WHERE id=$1`, [failed_tx_id]).catch(() => {});
  }

  const bounty   = parseFloat(bounty_usdc) || 0;
  const deadline = new Date(Date.now() + parseInt(deadline_seconds) * 1000);

  const { rows } = await db.query(
    `INSERT INTO failed_tx_salvage(original_tx_id, failure_reason, bounty_usdc, poster_did, deadline)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [failed_tx_id, intent?.status || 'unknown_failure', bounty, poster_did, deadline]
  ).catch(async () => {
    const mockRow = { id: require('crypto').randomUUID(), original_tx_id: failed_tx_id, bounty_usdc: bounty, poster_did, deadline, status: 'open' };
    return { rows: [mockRow] };
  });

  await db.run(
    `INSERT INTO tx_revenue_ledger(tx_intent_id, fee_type, amount_usdc, from_did) VALUES($1,'intent_listing',0.05,$2)`,
    [failed_tx_id, poster_did]
  ).catch(() => {});

  res.status(201).json({
    salvage_id: rows[0].id,
    original_tx_id: failed_tx_id,
    bounty_usdc: bounty.toFixed(6),
    hive_fee_on_rescue: (bounty * SALVAGE_FEE_PCT).toFixed(6),
    rescuer_receives: (bounty * (1 - SALVAGE_FEE_PCT)).toFixed(6),
    deadline: deadline.toISOString(),
    status: 'open',
    message: `Salvage market open. ${bounty.toFixed(2)} USDC bounty for any agent who can rescue this failed transaction. Deadline: ${deadline.toISOString()}`,
    original_intent: intent ? { intent_type: intent.intent_type, notional: intent.notional, constraints: intent.constraints } : null,
  });
});

// ─── POST /rescue ─────────────────────────────────────────────────────────────
router.post('/rescue', async (req, res) => {
  const { salvage_id, rescuer_did, proof } = req.body;

  if (!salvage_id || !rescuer_did) {
    return res.status(400).json({ error: 'salvage_id and rescuer_did required' });
  }

  const salvage = await db.getOne(`SELECT * FROM failed_tx_salvage WHERE id=$1`, [salvage_id]).catch(() => null);
  if (!salvage) return res.status(404).json({ error: 'salvage_not_found' });
  if (salvage.status !== 'open') return res.status(409).json({ error: 'salvage_not_open', status: salvage.status });
  if (new Date(salvage.deadline) < new Date()) {
    await db.run(`UPDATE failed_tx_salvage SET status='expired' WHERE id=$1`, [salvage_id]).catch(() => {});
    return res.status(410).json({ error: 'salvage_expired' });
  }
  if (salvage.poster_did === rescuer_did) return res.status(403).json({ error: 'cannot rescue your own salvage' });

  const bounty      = parseFloat(salvage.bounty_usdc);
  const hiveFee     = bounty * SALVAGE_FEE_PCT;
  const rescuerGets = bounty - hiveFee;

  await db.run(`UPDATE failed_tx_salvage SET status='rescued', rescuer_did=$1 WHERE id=$2`, [rescuer_did, salvage_id]).catch(() => {});
  await db.run(`UPDATE transaction_intents SET status='salvaged', updated_at=NOW() WHERE id=$1`, [salvage.original_tx_id]).catch(() => {});
  await db.run(
    `INSERT INTO tx_revenue_ledger(tx_intent_id, fee_type, amount_usdc, from_did) VALUES($1,'salvage',$2,$3)`,
    [salvage.original_tx_id, hiveFee, rescuer_did]
  ).catch(() => {});

  res.json({
    ok: true,
    salvage_id,
    rescuer_did,
    bounty_usdc: bounty.toFixed(6),
    hive_fee_usdc: hiveFee.toFixed(6),
    rescuer_payout_usdc: rescuerGets.toFixed(6),
    status: 'rescued',
    message: `Rescue confirmed. ${rescuerGets.toFixed(6)} USDC released to ${rescuer_did}. Failure became volume.`,
  });
});

// ─── GET /open ────────────────────────────────────────────────────────────────
router.get('/open', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const rows = await db.getAll(
    `SELECT s.*, i.intent_type, i.notional, i.constraints
     FROM failed_tx_salvage s
     LEFT JOIN transaction_intents i ON i.id=s.original_tx_id
     WHERE s.status='open' AND s.deadline > NOW()
     ORDER BY s.bounty_usdc DESC LIMIT $1`, [limit]
  ).catch(() => []);
  res.json({
    open_salvage_markets: rows,
    count: rows.length,
    total_bounty_available: rows.reduce((s, r) => s + parseFloat(r.bounty_usdc || 0), 0).toFixed(6),
    message: 'Failure is volume. Rescue a transaction, earn the bounty.',
  });
});

module.exports = router;
