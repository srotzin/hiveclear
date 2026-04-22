'use strict';
// Merged from hivetransactions — route/bidding routes
// Mounted at /v1/transaction/route in server.js
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

const AUCTION_FEE_PCT = 0.003;

async function ensureSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS route_bids (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tx_intent_id   TEXT REFERENCES transaction_intents(id),
        provider_did   TEXT NOT NULL,
        price          NUMERIC(18,6) NOT NULL,
        latency_ms     INT NOT NULL,
        trust_score    NUMERIC(6,2) DEFAULT 0,
        guarantee      BOOLEAN DEFAULT FALSE,
        route_fee_bps  INT DEFAULT 60,
        status         TEXT DEFAULT 'pending',
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_route_bids_intent ON route_bids(tx_intent_id);
    `);
  } catch (e) {
    console.warn('[tx-route] ensureSchema warning:', e.message);
  }
}

ensureSchema();

// ─── POST /bid ────────────────────────────────────────────────────────────────
router.post('/bid', async (req, res) => {
  const { tx_intent_id, provider_did, price, latency_ms, guarantee = false, route_fee_bps = 60, trust_score } = req.body;

  if (!tx_intent_id || !provider_did || !price || !latency_ms) {
    return res.status(400).json({ error: 'tx_intent_id, provider_did, price, latency_ms required' });
  }

  const intent = await db.getOne(`SELECT * FROM transaction_intents WHERE id=$1`, [tx_intent_id]);
  if (!intent) return res.status(404).json({ error: 'intent_not_found' });
  if (!['open','open_for_routing'].includes(intent.status)) {
    return res.status(409).json({ error: 'intent_not_open', status: intent.status });
  }
  if (new Date(intent.deadline) < new Date()) {
    return res.status(410).json({ error: 'intent_expired' });
  }

  const { rows: bid } = await db.query(
    `INSERT INTO route_bids(tx_intent_id, provider_did, price, latency_ms, trust_score, guarantee, route_fee_bps)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tx_intent_id, provider_did, parseFloat(price), parseInt(latency_ms), parseFloat(trust_score || 0), guarantee, parseInt(route_fee_bps)]
  ).catch(async () => {
    // In-memory fallback: simulate insert
    const mockBid = { id: require('crypto').randomUUID(), tx_intent_id, provider_did, price: parseFloat(price), latency_ms: parseInt(latency_ms), trust_score: parseFloat(trust_score || 0), guarantee, route_fee_bps: parseInt(route_fee_bps), status: 'pending' };
    return { rows: [mockBid] };
  });

  const allBids = await db.getAll(
    `SELECT * FROM route_bids WHERE tx_intent_id=$1 AND status='pending' ORDER BY created_at DESC`,
    [tx_intent_id]
  ).catch(() => [bid[0]]);

  const scored = allBids.map(b => {
    const priceScore   = 100 - (parseFloat(b.price) / parseFloat(intent.notional)) * 100;
    const latencyScore = Math.max(0, 100 - (b.latency_ms / 20));
    const tScore       = parseFloat(b.trust_score || 50);
    const total = (priceScore * 0.5) + (latencyScore * 0.3) + (tScore * 0.2);
    return { ...b, composite_score: total.toFixed(2) };
  }).sort((a, b) => b.composite_score - a.composite_score);

  const isWinning = scored.length > 0 && String(scored[0].id) === String(bid[0].id);

  res.status(201).json({
    bid_id: bid[0].id,
    tx_intent_id,
    provider_did,
    price: parseFloat(price).toFixed(6),
    latency_ms: parseInt(latency_ms),
    guarantee,
    route_fee_bps,
    composite_score: scored.find(s => String(s.id) === String(bid[0].id))?.composite_score || '0',
    current_rank: scored.findIndex(s => String(s.id) === String(bid[0].id)) + 1,
    total_bids: allBids.length,
    currently_winning: isWinning,
    auction_fee_if_won: (parseFloat(price) * AUCTION_FEE_PCT).toFixed(6),
    message: isWinning ? 'Your bid is currently winning the route auction.' : `You are ranked #${scored.findIndex(s => String(s.id) === String(bid[0].id)) + 1} of ${allBids.length} bids.`,
  });
});

// ─── GET /bids/:tx_intent_id ──────────────────────────────────────────────────
router.get('/bids/:tx_intent_id', async (req, res) => {
  const { tx_intent_id } = req.params;
  const intent = await db.getOne(`SELECT privacy FROM transaction_intents WHERE id=$1`, [tx_intent_id]);
  if (!intent) return res.status(404).json({ error: 'intent_not_found' });

  const rows = await db.getAll(
    `SELECT * FROM route_bids WHERE tx_intent_id=$1 ORDER BY price ASC, latency_ms ASC`,
    [tx_intent_id]
  ).catch(() => []);

  const sanitized = rows.map((b, i) => ({
    rank: i + 1,
    bid_id: b.id,
    provider_did: intent.privacy === 'dark' ? `[PROVIDER_${i+1}]` : b.provider_did,
    price: b.price,
    latency_ms: b.latency_ms,
    guarantee: b.guarantee,
    route_fee_bps: b.route_fee_bps,
    status: b.status,
  }));

  res.json({ tx_intent_id, auction_status: 'open', bids: sanitized, total_bids: rows.length });
});

// ─── POST /select ─────────────────────────────────────────────────────────────
router.post('/select', async (req, res) => {
  const { tx_intent_id, bid_id, agent_did } = req.body;
  if (!tx_intent_id || !bid_id) return res.status(400).json({ error: 'tx_intent_id and bid_id required' });

  const intent = await db.getOne(`SELECT * FROM transaction_intents WHERE id=$1`, [tx_intent_id]);
  if (!intent) return res.status(404).json({ error: 'intent_not_found' });
  if (intent.agent_did !== agent_did) return res.status(403).json({ error: 'not your intent' });

  const bid = await db.getOne(`SELECT * FROM route_bids WHERE id=$1 AND tx_intent_id=$2`, [bid_id, tx_intent_id]);
  if (!bid) return res.status(404).json({ error: 'bid_not_found' });

  await db.run(`UPDATE route_bids SET status='rejected' WHERE tx_intent_id=$1 AND id<>$2`, [tx_intent_id, bid_id]).catch(() => {});
  await db.run(`UPDATE route_bids SET status='winning' WHERE id=$1`, [bid_id]).catch(() => {});
  await db.run(`UPDATE transaction_intents SET selected_route=$1, status='routed', updated_at=NOW() WHERE id=$2`, [bid_id, tx_intent_id]).catch(() => {});

  const auctionFee = parseFloat(bid.price) * 0.003;
  await db.run(
    `INSERT INTO tx_revenue_ledger(tx_intent_id, fee_type, amount_usdc, from_did) VALUES($1,'route_auction',$2,$3)`,
    [tx_intent_id, auctionFee, bid.provider_did]
  ).catch(() => {});
  await db.run(
    `UPDATE transaction_intents SET hive_earned_usdc=hive_earned_usdc+$1 WHERE id=$2`,
    [auctionFee, tx_intent_id]
  ).catch(() => {});

  res.json({ ok: true, tx_intent_id, winning_bid: bid, auction_fee_usdc: auctionFee.toFixed(6), status: 'routed' });
});

module.exports = router;
