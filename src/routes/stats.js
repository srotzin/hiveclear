const express = require('express');
const router = express.Router();
const db = require('../services/db');

// GET /v1/clear/stats
router.get('/', (req, res) => {
  try {
    const totalValidators = db.prepare(`SELECT COUNT(*) as cnt FROM validators WHERE status = 'active'`).get().cnt;
    const totalStake = db.prepare(`SELECT SUM(bond_amount_usdc) as total FROM validators WHERE status = 'active'`).get().total || 0;
    const totalVotingPower = db.prepare(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`).get().total || 0;

    // Today's stats
    const today = new Date().toISOString().split('T')[0];
    const settlementsToday = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE created_at >= ?`).get(today).cnt;
    const volumeToday = db.prepare(`SELECT SUM(amount_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= ?`).get(today).total || 0;
    const feesToday = db.prepare(`SELECT SUM(fee_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= ?`).get(today).total || 0;

    // Average settlement time
    const avgTime = db.prepare(`
      SELECT AVG((julianday(settled_at) - julianday(created_at)) * 86400000) as avg_ms
      FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
    `).get();

    // Uptime
    const avgUptime = db.prepare(`SELECT AVG(uptime_pct) as avg FROM validators WHERE status = 'active'`).get().avg || 100;

    // Consensus rate
    const totalResolved = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status IN ('approved', 'rejected')`).get().cnt;
    const totalApproved = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'approved'`).get().cnt;
    const consensusRate = totalResolved > 0 ? Math.round((totalApproved / totalResolved) * 10000) / 10000 : 1;

    res.json({
      total_validators: totalValidators,
      total_stake_usdc: Math.round(totalStake * 100) / 100,
      total_voting_power: totalVotingPower,
      settlements_today: settlementsToday,
      volume_today_usdc: Math.round(volumeToday * 100) / 100,
      fees_today_usdc: Math.round(feesToday * 100) / 100,
      avg_settlement_time_ms: Math.round(avgTime?.avg_ms || 0),
      uptime_pct: Math.round(avgUptime * 100) / 100,
      consensus_rate: consensusRate,
    });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
