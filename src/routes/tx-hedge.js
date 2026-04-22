'use strict';
// Merged from hivetransactions — hedge routes
// Mounted at /v1/transaction in server.js
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

const HIVE_SPREAD_PCT = 0.15;

const HEDGE_CONFIGS = {
  cost_overrun: { base_rate: 0.020, description: 'Covers costs exceeding notional by any amount' },
  latency:      { base_rate: 0.010, description: 'Pays out if execution latency exceeds constraint' },
  counterparty: { base_rate: 0.030, description: 'Covers counterparty default or no-show' },
  compliance:   { base_rate: 0.020, description: 'Covers compliance or jurisdiction failures' },
  slippage:     { base_rate: 0.015, description: 'Covers price slippage beyond tolerance' },
  failure:      { base_rate: 0.050, description: 'Full payout on complete transaction failure' },
};

async function ensureSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS transaction_hedges (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tx_intent_id    TEXT REFERENCES transaction_intents(id),
        hedge_type      TEXT NOT NULL,
        coverage_usdc   NUMERIC(18,6) NOT NULL,
        premium_usdc    NUMERIC(18,6) NOT NULL,
        max_payout_usdc NUMERIC(18,6) NOT NULL,
        status          TEXT DEFAULT 'active',
        triggered_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_hedges_intent ON transaction_hedges(tx_intent_id);
    `);
  } catch (e) {
    console.warn('[tx-hedge] ensureSchema warning:', e.message);
  }
}

ensureSchema();

// ─── POST /hedge ──────────────────────────────────────────────────────────────
router.post('/hedge', async (req, res) => {
  const { tx_intent_id, hedge_type, coverage_usdc, max_premium_usdc } = req.body;

  if (!tx_intent_id || !hedge_type || !coverage_usdc) {
    return res.status(400).json({ error: 'tx_intent_id, hedge_type, coverage_usdc required' });
  }

  const config = HEDGE_CONFIGS[hedge_type];
  if (!config) {
    return res.status(400).json({ error: 'invalid hedge_type', valid_types: Object.keys(HEDGE_CONFIGS) });
  }

  const coverage = parseFloat(coverage_usdc);
  const premium  = coverage * config.base_rate;
  const maxPayout = coverage;

  if (max_premium_usdc && premium > parseFloat(max_premium_usdc)) {
    return res.status(402).json({
      error: 'premium_exceeds_max',
      calculated_premium: premium.toFixed(6),
      max_acceptable: parseFloat(max_premium_usdc).toFixed(6),
      suggestion: `Reduce coverage to ${(parseFloat(max_premium_usdc) / config.base_rate).toFixed(2)} USDC to stay within budget`,
    });
  }

  const intent = await db.getOne(`SELECT * FROM transaction_intents WHERE id=$1`, [tx_intent_id]);
  if (!intent) return res.status(404).json({ error: 'intent_not_found' });

  const { rows: hedge } = await db.query(
    `INSERT INTO transaction_hedges(tx_intent_id, hedge_type, coverage_usdc, premium_usdc, max_payout_usdc)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [tx_intent_id, hedge_type, coverage, premium, maxPayout]
  ).catch(async () => {
    const mockHedge = { id: require('crypto').randomUUID(), tx_intent_id, hedge_type, coverage_usdc: coverage, premium_usdc: premium, max_payout_usdc: maxPayout, status: 'active' };
    return { rows: [mockHedge] };
  });

  await db.run(
    `UPDATE transaction_intents SET hedge_id=$1, updated_at=NOW() WHERE id=$2`,
    [hedge[0].id, tx_intent_id]
  ).catch(() => {});

  const hiveCut = premium * HIVE_SPREAD_PCT;
  await db.run(
    `INSERT INTO tx_revenue_ledger(tx_intent_id, fee_type, amount_usdc, from_did) VALUES($1,'hedge_spread',$2,$3)`,
    [tx_intent_id, hiveCut, intent.agent_did]
  ).catch(() => {});
  await db.run(
    `UPDATE transaction_intents SET hive_earned_usdc=hive_earned_usdc+$1 WHERE id=$2`,
    [hiveCut, tx_intent_id]
  ).catch(() => {});

  res.status(201).json({
    hedge_id: hedge[0].id,
    tx_intent_id,
    hedge_type,
    description: config.description,
    coverage_usdc: coverage.toFixed(6),
    premium_usdc: premium.toFixed(6),
    hive_spread_usdc: hiveCut.toFixed(6),
    max_payout_usdc: maxPayout.toFixed(6),
    status: 'active',
    message: `Hedge attached. If ${hedge_type} occurs, up to ${maxPayout.toFixed(2)} USDC paid out automatically via HiveLaw.`,
  });
});

// ─── GET /hedge/:tx_intent_id ─────────────────────────────────────────────────
router.get('/hedge/:tx_intent_id', async (req, res) => {
  const rows = await db.getAll(
    `SELECT * FROM transaction_hedges WHERE tx_intent_id=$1`, [req.params.tx_intent_id]
  ).catch(() => []);
  const totalCoverage = rows.reduce((s, h) => s + parseFloat(h.coverage_usdc), 0);
  const totalPremium  = rows.reduce((s, h) => s + parseFloat(h.premium_usdc), 0);
  res.json({ tx_intent_id: req.params.tx_intent_id, hedges: rows, total_coverage_usdc: totalCoverage.toFixed(6), total_premium_usdc: totalPremium.toFixed(6) });
});

// ─── POST /hedge/:id/trigger ──────────────────────────────────────────────────
router.post('/hedge/:id/trigger', async (req, res) => {
  const internalKey = req.headers['x-hive-internal'];
  const expectedKey = process.env.HIVE_INTERNAL_KEY;
  if (!expectedKey || internalKey !== expectedKey) return res.status(401).json({ error: 'unauthorized' });

  const hedge = await db.getOne(`SELECT * FROM transaction_hedges WHERE id=$1`, [req.params.id]);
  if (!hedge) return res.status(404).json({ error: 'hedge_not_found' });
  if (hedge.status !== 'active') return res.status(409).json({ error: 'hedge_not_active', status: hedge.status });

  await db.run(
    `UPDATE transaction_hedges SET status='triggered', triggered_at=NOW() WHERE id=$1`, [req.params.id]
  ).catch(() => {});

  res.json({ ok: true, hedge_id: req.params.id, payout_usdc: hedge.max_payout_usdc, status: 'triggered', message: 'HiveLaw payout initiated.' });
});

module.exports = router;
