'use strict';
// Merged from hivetransactions — intent routes
// Mounted at /v1/transaction in server.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const db      = require('../services/db');

// Fee constants
const INTENT_LISTING_FEE_USDC = 0.10;
const PRIORITY_FEES = {
  standard:   0,
  fast:       0.50,
  guaranteed: 2.00,
  sovereign:  5.00,
  dark:      10.00,
};

function estimateFeePool(notional, privacy, priority = 'standard') {
  const routeAuction  = notional * 0.006;
  const hedgeSpread   = notional * 0.002;
  const settlementBps = notional * 0.001;
  const darkPremium   = privacy === 'dark' ? notional * 0.003 : 0;
  const priorityFee   = PRIORITY_FEES[priority] || 0;
  return (INTENT_LISTING_FEE_USDC + routeAuction + hedgeSpread + settlementBps + darkPremium + priorityFee).toFixed(4);
}

async function ensureSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS transaction_intents (
        id               TEXT PRIMARY KEY,
        agent_did        TEXT NOT NULL,
        intent_type      TEXT NOT NULL,
        notional         NUMERIC(18,6) NOT NULL,
        deadline         TIMESTAMPTZ NOT NULL,
        privacy          TEXT DEFAULT 'public',
        constraints      JSONB DEFAULT '{}',
        status           TEXT DEFAULT 'open',
        selected_route   TEXT,
        hedge_id         TEXT,
        bundle_id        TEXT,
        fee_pool_usdc    NUMERIC(18,6) DEFAULT 0,
        hive_earned_usdc NUMERIC(18,6) DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tx_revenue_ledger (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tx_intent_id   TEXT,
        fee_type       TEXT NOT NULL,
        amount_usdc    NUMERIC(18,6) NOT NULL,
        from_did       TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_intents_did    ON transaction_intents(agent_did);
      CREATE INDEX IF NOT EXISTS idx_tx_intents_status ON transaction_intents(status);
      CREATE INDEX IF NOT EXISTS idx_tx_revenue_type   ON tx_revenue_ledger(fee_type);
    `);
  } catch (e) {
    // Idempotent — ignore errors if tables already exist or using in-memory fallback
    console.warn('[tx-intent] ensureSchema warning:', e.message);
  }
}

ensureSchema();

// ─── POST /intent ─────────────────────────────────────────────────────────────
router.post('/intent', async (req, res) => {
  const {
    agent_did, intent_type, notional, deadline_seconds,
    privacy = 'public', constraints = {}, priority = 'standard'
  } = req.body;

  if (!agent_did || !intent_type || !notional) {
    return res.status(400).json({ error: 'agent_did, intent_type, and notional required' });
  }
  if (!agent_did.startsWith('did:hive:')) {
    return res.status(400).json({ error: 'agent_did must be a valid Hive DID (did:hive:...)' });
  }

  const notionalNum  = parseFloat(notional);
  const deadlineSecs = parseInt(deadline_seconds) || 300;
  const deadline     = new Date(Date.now() + deadlineSecs * 1000);
  const txId         = 'txi_' + uuidv4().replace(/-/g,'').slice(0,12);
  const feePool      = parseFloat(estimateFeePool(notionalNum, privacy, priority));

  await db.run(
    `INSERT INTO transaction_intents(id, agent_did, intent_type, notional, deadline, privacy, constraints, fee_pool_usdc)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [txId, agent_did, intent_type, notionalNum, deadline, privacy, JSON.stringify(constraints), feePool]
  );

  await db.run(
    `INSERT INTO tx_revenue_ledger(tx_intent_id, fee_type, amount_usdc, from_did) VALUES($1,'intent_listing',$2,$3)`,
    [txId, INTENT_LISTING_FEE_USDC, agent_did]
  ).catch(() => {});

  const hedgeRecs = [];
  if (intent_type === 'compute_purchase') {
    hedgeRecs.push({ hedge_type: 'cost_overrun',  recommended_coverage: (notionalNum * 0.1).toFixed(2),  estimated_premium: (notionalNum * 0.002).toFixed(2) });
    hedgeRecs.push({ hedge_type: 'latency',        recommended_coverage: (notionalNum * 0.05).toFixed(2), estimated_premium: (notionalNum * 0.001).toFixed(2) });
  }
  if (['settlement','labor','data_access'].includes(intent_type)) {
    hedgeRecs.push({ hedge_type: 'counterparty',   recommended_coverage: (notionalNum * 0.15).toFixed(2), estimated_premium: (notionalNum * 0.003).toFixed(2) });
    hedgeRecs.push({ hedge_type: 'compliance',     recommended_coverage: (notionalNum * 0.10).toFixed(2), estimated_premium: (notionalNum * 0.002).toFixed(2) });
  }
  hedgeRecs.push({ hedge_type: 'failure', recommended_coverage: notionalNum.toFixed(2), estimated_premium: (notionalNum * 0.005).toFixed(2) });

  res.status(201).json({
    tx_intent_id: txId,
    status: 'open_for_routing',
    agent_did,
    intent_type,
    notional: notionalNum.toFixed(6),
    deadline: deadline.toISOString(),
    privacy,
    priority,
    route_auction_open: true,
    hedge_recommendations: hedgeRecs,
    insurance_quotes: [
      { type: 'basic', coverage: notionalNum.toFixed(2), premium: (notionalNum * 0.003).toFixed(4) },
      { type: 'full',  coverage: notionalNum.toFixed(2), premium: (notionalNum * 0.008).toFixed(4) },
    ],
    estimated_fee_pool: feePool,
    listing_fee_usdc: INTENT_LISTING_FEE_USDC,
    estimated_savings_usdc: (notionalNum * 0.018).toFixed(2),
    message: `Transaction intent ${txId} is now a live financial object. Route auction open. Hedge and insure before execution.`,
  });
});

// ─── GET /intents ─────────────────────────────────────────────────────────────
router.get('/intents', async (req, res) => {
  const { status = 'open', limit = 20 } = req.query;
  const lim = Math.min(parseInt(limit), 100);

  const rows = await db.getAll(
    `SELECT i.*, COUNT(rb.id) as bid_count
     FROM transaction_intents i
     LEFT JOIN route_bids rb ON rb.tx_intent_id=i.id
     WHERE i.status=$1 AND i.deadline > NOW()
     GROUP BY i.id ORDER BY i.created_at DESC LIMIT $2`,
    [status, lim]
  ).then(r => r.map(row => {
    if (row.privacy === 'dark')   return { ...row, agent_did: '[SEALED]', constraints: {}, notional: null };
    if (row.privacy === 'sealed') return { ...row, constraints: {}, notional: null };
    return row;
  })).catch(() => []);

  res.json({ intents: rows, count: rows.length, book: 'transaction_intent_book' });
});

// ─── GET /intent/:id ──────────────────────────────────────────────────────────
router.get('/intent/:id', async (req, res) => {
  const intent = await db.getOne(`SELECT * FROM transaction_intents WHERE id=$1`, [req.params.id]);
  if (!intent) return res.status(404).json({ error: 'intent_not_found' });
  if (intent.privacy === 'dark') return res.json({ ...intent, agent_did: '[SEALED]', constraints: {}, notional: null });
  res.json(intent);
});

// ─── GET /history/:did ────────────────────────────────────────────────────────
router.get('/history/:did', async (req, res) => {
  const { did } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = await db.getAll(
    `SELECT * FROM transaction_intents WHERE agent_did=$1 ORDER BY created_at DESC LIMIT $2`,
    [did, limit]
  ).catch(() => []);
  const totalNotional = rows.reduce((s, r) => s + parseFloat(r.notional || 0), 0);
  const totalFees     = rows.reduce((s, r) => s + parseFloat(r.hive_earned_usdc || 0), 0);
  res.json({ did, intents: rows, count: rows.length, total_notional_usdc: totalNotional.toFixed(6), total_hive_fees_paid: totalFees.toFixed(6) });
});

module.exports = router;
