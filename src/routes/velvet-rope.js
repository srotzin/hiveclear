const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { createSettlement, FEE_RATE } = require('../services/settlement');
const whiteGlove = require('../middleware/white-glove-errors');

const PRIORITY_FEE_USDC = 5;

// GET /v1/clear/queue — Settlement queue display with inflated numbers
router.get('/queue', async (req, res) => {
  try {
    const realPendingRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`);
    const realPending = parseInt(realPendingRow.cnt, 10);

    // Recent clearances (last 10 approved settlements)
    const recentRows = await db.getAll(`
      SELECT settlement_id, amount_usdc, settled_at, votes_for, total_voting_power, priority
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
      ORDER BY settled_at DESC LIMIT 10
    `);

    const recentClearances = recentRows.map(s => ({
      settlement_id: s.settlement_id,
      amount_usdc: parseFloat(s.amount_usdc),
      cleared_at: s.settled_at,
      consensus_pct: parseFloat(s.total_voting_power) > 0
        ? Math.round((parseFloat(s.votes_for) / parseFloat(s.total_voting_power)) * 100)
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
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'queue' });
  }
});

// POST /v1/clear/priority-settle — Priority settlement (flat $5 fee)
router.post('/priority-settle', async (req, res) => {
  try {
    const { transaction_id, from_did, to_did, amount_usdc, service, memo } = req.body;

    // White-glove: missing fields
    const missing = [];
    if (!from_did) missing.push('from_did');
    if (!to_did) missing.push('to_did');
    if (!amount_usdc && amount_usdc !== 0) missing.push('amount_usdc');
    if (missing.length > 0) {
      return whiteGlove.missingFields(res, { missing, endpoint: 'POST /v1/clear/priority-settle' });
    }
    if (typeof amount_usdc !== 'number' || amount_usdc <= 0) {
      return whiteGlove.missingFields(res, {
        missing: ['amount_usdc'],
        endpoint: 'POST /v1/clear/priority-settle',
      });
    }

    // Create normal settlement first
    const result = await createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo });

    // Upgrade to priority: set priority flag and override fee to flat $5
    await db.run('UPDATE settlements SET priority = 1, fee_usdc = $1 WHERE settlement_id = $2',
      [PRIORITY_FEE_USDC, result.settlement_id]);

    // Add tier info if available
    const tier = req.hiveTier;
    const response = {
      ...result,
      priority: true,
      fee_usdc: PRIORITY_FEE_USDC,
      note: '\u26a1 Priority \u2014 bonded validators will vote on this settlement first',
    };
    if (tier) {
      response.tier = tier.name;
      response.consensus_type = tier.consensus;
    }

    res.status(201).json(response);
  } catch (err) {
    console.error('[velvet-rope/priority-settle] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'priority_settle' });
  }
});

// GET /v1/clear/leaderboard — Settlement leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    // Top settlers today (by from_did volume)
    const topToday = await db.getAll(`
      SELECT from_did as did,
        SUM(amount_usdc) as volume_usdc,
        COUNT(*) as settlements
      FROM settlements
      WHERE status = 'approved' AND created_at >= $1
      GROUP BY from_did
      ORDER BY volume_usdc DESC
      LIMIT 10
    `, [todayISO]);

    // Add avg consensus time per settler today
    const topTodayWithTime = [];
    for (const row of topToday) {
      const avgTime = await db.getOne(`
        SELECT AVG(EXTRACT(EPOCH FROM (settled_at::timestamp - created_at::timestamp)) * 1000) as avg_ms
        FROM settlements
        WHERE from_did = $1 AND status = 'approved' AND created_at >= $2 AND settled_at IS NOT NULL
      `, [row.did, todayISO]);
      topTodayWithTime.push({
        did: row.did,
        volume_usdc: parseFloat(row.volume_usdc),
        settlements: parseInt(row.settlements, 10),
        avg_consensus_time_ms: Math.round(parseFloat(avgTime?.avg_ms) || 0),
      });
    }

    // Top settlers all time
    const topAllTime = await db.getAll(`
      SELECT from_did as did,
        SUM(amount_usdc) as volume_usdc,
        COUNT(*) as settlements
      FROM settlements
      WHERE status = 'approved'
      GROUP BY from_did
      ORDER BY volume_usdc DESC
      LIMIT 10
    `);

    const topAllTimeWithTime = [];
    for (const row of topAllTime) {
      const avgTime = await db.getOne(`
        SELECT AVG(EXTRACT(EPOCH FROM (settled_at::timestamp - created_at::timestamp)) * 1000) as avg_ms
        FROM settlements
        WHERE from_did = $1 AND status = 'approved' AND settled_at IS NOT NULL
      `, [row.did]);
      topAllTimeWithTime.push({
        did: row.did,
        volume_usdc: parseFloat(row.volume_usdc),
        settlements: parseInt(row.settlements, 10),
        avg_consensus_time_ms: Math.round(parseFloat(avgTime?.avg_ms) || 0),
      });
    }

    // Totals
    const totals = await db.getOne(`
      SELECT COALESCE(SUM(amount_usdc), 0) as total_settled,
        COALESCE(SUM(fee_usdc), 0) as total_fees
      FROM settlements WHERE status = 'approved'
    `);

    res.json({
      top_settlers_today: topTodayWithTime,
      top_settlers_all_time: topAllTimeWithTime,
      total_settled_usdc: parseFloat(totals.total_settled),
      total_fees_collected_usdc: Math.round(parseFloat(totals.total_fees) * 100) / 100,
    });
  } catch (err) {
    console.error('[velvet-rope/leaderboard] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'leaderboard' });
  }
});

// GET /v1/clear/consensus/health — Consensus health display
router.get('/consensus/health', async (req, res) => {
  try {
    const activeValidators = await db.getAll(`SELECT * FROM validators WHERE status = 'active'`);
    const totalVotingPower = activeValidators.reduce((sum, v) => sum + parseFloat(v.voting_power), 0);

    // Average consensus time
    const avgTime = await db.getOne(`
      SELECT AVG(EXTRACT(EPOCH FROM (settled_at::timestamp - created_at::timestamp)) * 1000) as avg_ms
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
    `);

    // Average uptime
    const avgUptime = activeValidators.length > 0
      ? activeValidators.reduce((sum, v) => sum + (parseFloat(v.uptime_pct) || 100), 0) / activeValidators.length
      : 100;

    res.json({
      validators_online: activeValidators.length,
      total_voting_power: totalVotingPower,
      consensus_threshold_pct: 66.7,
      avg_consensus_time_ms: Math.round(parseFloat(avgTime?.avg_ms) || 0),
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
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'consensus_health' });
  }
});

module.exports = router;
