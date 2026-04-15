const express = require('express');
const router = express.Router();
const db = require('../services/db');

// GET /v1/clear/stats
router.get('/', async (req, res) => {
  try {
    const totalValidatorsRow = await db.getOne(`SELECT COUNT(*) as cnt FROM validators WHERE status = 'active'`);
    const totalValidators = parseInt(totalValidatorsRow.cnt, 10);

    const totalStakeRow = await db.getOne(`SELECT SUM(bond_amount_usdc) as total FROM validators WHERE status = 'active'`);
    const totalStake = parseFloat(totalStakeRow.total) || 0;

    const totalVotingPowerRow = await db.getOne(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`);
    const totalVotingPower = parseFloat(totalVotingPowerRow.total) || 0;

    // Today's stats
    const today = new Date().toISOString().split('T')[0];
    const settlementsTodayRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE created_at >= $1`, [today]);
    const settlementsToday = parseInt(settlementsTodayRow.cnt, 10);

    const volumeTodayRow = await db.getOne(`SELECT SUM(amount_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= $1`, [today]);
    const volumeToday = parseFloat(volumeTodayRow.total) || 0;

    const feesTodayRow = await db.getOne(`SELECT SUM(fee_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= $1`, [today]);
    const feesToday = parseFloat(feesTodayRow.total) || 0;

    // Average settlement time
    const avgTime = await db.getOne(`
      SELECT AVG(EXTRACT(EPOCH FROM (settled_at::timestamp - created_at::timestamp)) * 1000) as avg_ms
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
    `);

    // Uptime
    const avgUptimeRow = await db.getOne(`SELECT AVG(uptime_pct) as avg FROM validators WHERE status = 'active'`);
    const avgUptime = parseFloat(avgUptimeRow.avg) || 100;

    // Consensus rate
    const totalResolvedRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status IN ('approved', 'rejected')`);
    const totalResolved = parseInt(totalResolvedRow.cnt, 10);
    const totalApprovedRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'approved'`);
    const totalApproved = parseInt(totalApprovedRow.cnt, 10);
    const consensusRate = totalResolved > 0 ? Math.round((totalApproved / totalResolved) * 10000) / 10000 : 1;

    res.json({
      total_validators: totalValidators,
      total_stake_usdc: Math.round(totalStake * 100) / 100,
      total_voting_power: totalVotingPower,
      settlements_today: settlementsToday,
      volume_today_usdc: Math.round(volumeToday * 100) / 100,
      fees_today_usdc: Math.round(feesToday * 100) / 100,
      avg_settlement_time_ms: Math.round(parseFloat(avgTime?.avg_ms) || 0),
      uptime_pct: Math.round(avgUptime * 100) / 100,
      consensus_rate: consensusRate,
    });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
