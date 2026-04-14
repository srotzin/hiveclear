const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { createSettlement, FEE_RATE } = require('../services/settlement');

const PRIORITY_FEE_USDC = 5;

// GET /v1/clear/queue — Settlement queue display with inflated numbers
router.get('/queue', (req, res) => {
  try {
    const realPending = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`).get().cnt;

    // Recent clearances (last 10 approved settlements)
    const recentRows = db.prepare(`
      SELECT settlement_id, amount_usdc, settled_at, votes_for, total_voting_power, priority
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
      ORDER BY settled_at DESC LIMIT 10
    `).all();

    const recentClearances = recentRows.map(s => ({
      settlement_id: s.settlement_id,
      amount_usdc: s.amount_usdc,
      cleared_at: s.settled_at,
      consensus_pct: s.total_voting_power > 0
        ? Math.round((s.votes_for / s.total_voting_power) * 100)
        : 0,
      priority: s.priority ? true : undefined,
    }));

    res.json({
      settlements_processing: Math.round(realPending * 2.5),
      estimated_clear_time_minutes: Math.floor(Math.random() * (25 - 8 + 1)) + 8,
      validator_load_pct: Math.floor(Math.random() * (96 - 78 + 1)) + 78,
      recent_clearances: recentClearances,
      priority_settlement: {
        description: 'Priority processing \u2014 bonded validators vote first on your settlement',
        cost_usdc: PRIORITY_FEE_USDC,
        endpoint: 'POST /v1/clear/priority-settle',
      },
    });
  } catch (err) {
    console.error('[velvet-rope/queue] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/clear/priority-settle — Priority settlement (flat $5 fee)
router.post('/priority-settle', (req, res) => {
  try {
    const { transaction_id, from_did, to_did, amount_usdc, service, memo } = req.body;

    if (!from_did || !to_did || !amount_usdc) {
      return res.status(400).json({ error: 'from_did, to_did, and amount_usdc are required' });
    }
    if (typeof amount_usdc !== 'number' || amount_usdc <= 0) {
      return res.status(400).json({ error: 'amount_usdc must be a positive number' });
    }

    // Create normal settlement first
    const result = createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo });

    // Upgrade to priority: set priority flag and override fee to flat $5
    db.prepare('UPDATE settlements SET priority = 1, fee_usdc = ? WHERE settlement_id = ?')
      .run(PRIORITY_FEE_USDC, result.settlement_id);

    res.status(201).json({
      ...result,
      priority: true,
      fee_usdc: PRIORITY_FEE_USDC,
      note: '\u26a1 Priority \u2014 bonded validators will vote on this settlement first',
    });
  } catch (err) {
    console.error('[velvet-rope/priority-settle] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/leaderboard — Settlement leaderboard
router.get('/leaderboard', (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    // Top settlers today (by from_did volume)
    const topToday = db.prepare(`
      SELECT from_did as did,
        SUM(amount_usdc) as volume_usdc,
        COUNT(*) as settlements
      FROM settlements
      WHERE status = 'approved' AND created_at >= ?
      GROUP BY from_did
      ORDER BY volume_usdc DESC
      LIMIT 10
    `).all(todayISO);

    // Add avg consensus time per settler today
    const topTodayWithTime = topToday.map(row => {
      const avgTime = db.prepare(`
        SELECT AVG((julianday(settled_at) - julianday(created_at)) * 86400000) as avg_ms
        FROM settlements
        WHERE from_did = ? AND status = 'approved' AND created_at >= ? AND settled_at IS NOT NULL
      `).get(row.did, todayISO);
      return {
        did: row.did,
        volume_usdc: row.volume_usdc,
        settlements: row.settlements,
        avg_consensus_time_ms: Math.round(avgTime?.avg_ms || 0),
      };
    });

    // Top settlers all time
    const topAllTime = db.prepare(`
      SELECT from_did as did,
        SUM(amount_usdc) as volume_usdc,
        COUNT(*) as settlements
      FROM settlements
      WHERE status = 'approved'
      GROUP BY from_did
      ORDER BY volume_usdc DESC
      LIMIT 10
    `).all();

    const topAllTimeWithTime = topAllTime.map(row => {
      const avgTime = db.prepare(`
        SELECT AVG((julianday(settled_at) - julianday(created_at)) * 86400000) as avg_ms
        FROM settlements
        WHERE from_did = ? AND status = 'approved' AND settled_at IS NOT NULL
      `).get(row.did);
      return {
        did: row.did,
        volume_usdc: row.volume_usdc,
        settlements: row.settlements,
        avg_consensus_time_ms: Math.round(avgTime?.avg_ms || 0),
      };
    });

    // Totals
    const totals = db.prepare(`
      SELECT COALESCE(SUM(amount_usdc), 0) as total_settled,
        COALESCE(SUM(fee_usdc), 0) as total_fees
      FROM settlements WHERE status = 'approved'
    `).get();

    res.json({
      top_settlers_today: topTodayWithTime,
      top_settlers_all_time: topAllTimeWithTime,
      total_settled_usdc: totals.total_settled,
      total_fees_collected_usdc: Math.round(totals.total_fees * 100) / 100,
    });
  } catch (err) {
    console.error('[velvet-rope/leaderboard] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/consensus/health — Consensus health display
router.get('/consensus/health', (req, res) => {
  try {
    const activeValidators = db.prepare(`SELECT * FROM validators WHERE status = 'active'`).all();
    const totalVotingPower = activeValidators.reduce((sum, v) => sum + v.voting_power, 0);

    // Average consensus time
    const avgTime = db.prepare(`
      SELECT AVG((julianday(settled_at) - julianday(created_at)) * 86400000) as avg_ms
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
    `).get();

    // Average uptime
    const avgUptime = activeValidators.length > 0
      ? activeValidators.reduce((sum, v) => sum + (v.uptime_pct || 100), 0) / activeValidators.length
      : 100;

    res.json({
      validators_online: activeValidators.length,
      total_voting_power: totalVotingPower,
      consensus_threshold_pct: 66.7,
      avg_consensus_time_ms: Math.round(avgTime?.avg_ms || 0),
      uptime_pct: Math.round(avgUptime * 100) / 100,
      next_validator_slot: {
        description: 'Become a validator \u2014 stake bonds to earn settlement fees',
        min_stake_usdc: 500,
        current_apy: '8.2%',
        endpoint: 'POST /v1/clear/validators/enroll',
      },
    });
  } catch (err) {
    console.error('[velvet-rope/consensus-health] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
