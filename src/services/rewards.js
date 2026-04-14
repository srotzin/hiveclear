const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function getRewardBalance(did) {
  const balance = db.prepare('SELECT * FROM reward_balances WHERE did = ?').get(did);
  if (!balance) {
    return { did, total_earned_usdc: 0, pending_usdc: 0, last_distribution: null, breakdown: { settlement_fees: 0, pool_rewards: 0 } };
  }

  // Get breakdown from distributions
  const distributions = db.prepare(`
    SELECT distribution_details FROM reward_distributions ORDER BY distributed_at DESC LIMIT 10
  `).all();

  let poolRewards = 0;
  for (const d of distributions) {
    try {
      const details = JSON.parse(d.distribution_details || '[]');
      const entry = details.find(e => e.did === did);
      if (entry) poolRewards += entry.amount;
    } catch {}
  }

  return {
    did,
    total_earned_usdc: Math.round(balance.total_earned_usdc * 100) / 100,
    pending_usdc: Math.round(balance.pending_usdc * 100) / 100,
    last_distribution: balance.last_distribution_at,
    breakdown: {
      settlement_fees: Math.round((balance.total_earned_usdc - poolRewards) * 100) / 100,
      pool_rewards: Math.round(poolRewards * 100) / 100,
    },
  };
}

function distributeRewards() {
  const pool = db.prepare('SELECT * FROM reward_pool WHERE id = 1').get();
  if (!pool || pool.balance_usdc <= 0) {
    return { distribution_id: null, total_distributed_usdc: 0, validators_paid: 0, message: 'No funds in pool' };
  }

  const validators = db.prepare(`SELECT did, voting_power FROM validators WHERE status = 'active'`).all();
  const totalPower = validators.reduce((sum, v) => sum + v.voting_power, 0);
  if (totalPower === 0 || validators.length === 0) {
    return { distribution_id: null, total_distributed_usdc: 0, validators_paid: 0, message: 'No active validators' };
  }

  const distributionId = `dist_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const amountToDistribute = pool.balance_usdc;
  const details = [];

  const updateBalance = db.prepare(`
    UPDATE reward_balances SET pending_usdc = pending_usdc + ?, total_earned_usdc = total_earned_usdc + ?, last_distribution_at = ? WHERE did = ?
  `);
  const updateValidator = db.prepare(`
    UPDATE validators SET total_earned_usdc = total_earned_usdc + ? WHERE did = ?
  `);

  const distribute = db.transaction(() => {
    for (const v of validators) {
      const share = (v.voting_power / totalPower) * amountToDistribute;
      const rounded = Math.round(share * 100) / 100;
      updateBalance.run(rounded, rounded, now, v.did);
      updateValidator.run(rounded, v.did);
      details.push({ did: v.did, voting_power: v.voting_power, amount: rounded });
    }

    db.prepare(`
      UPDATE reward_pool SET balance_usdc = 0, total_distributed_usdc = total_distributed_usdc + ?, last_updated = ? WHERE id = 1
    `).run(amountToDistribute, now);

    db.prepare(`
      INSERT INTO reward_distributions (distribution_id, total_distributed_usdc, validators_paid, distribution_details, distributed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(distributionId, amountToDistribute, validators.length, JSON.stringify(details), now);
  });

  distribute();

  console.log(`[reward-distributor] Distributed $${amountToDistribute.toFixed(2)} to ${validators.length} validators`);

  return {
    distribution_id: distributionId,
    total_distributed_usdc: Math.round(amountToDistribute * 100) / 100,
    validators_paid: validators.length,
    timestamp: now,
  };
}

function getRewardPool() {
  const pool = db.prepare('SELECT * FROM reward_pool WHERE id = 1').get();
  const lastDist = db.prepare('SELECT distributed_at FROM reward_distributions ORDER BY distributed_at DESC LIMIT 1').get();

  // Estimate daily inflow from recent settlements
  const recentFees = db.prepare(`
    SELECT SUM(fee_usdc) as total FROM settlements
    WHERE status = 'approved' AND settled_at >= datetime('now', '-1 day')
  `).get();
  const dailyInflow = (recentFees?.total || 0) * 0.20; // 20% of fees go to pool

  return {
    pool_balance_usdc: Math.round((pool?.balance_usdc || 0) * 100) / 100,
    daily_inflow_usdc: Math.round(dailyInflow * 100) / 100,
    next_distribution: lastDist ? new Date(new Date(lastDist.distributed_at).getTime() + 24 * 60 * 60 * 1000).toISOString() : 'pending',
    total_distributed_usdc: Math.round((pool?.total_distributed_usdc || 0) * 100) / 100,
  };
}

module.exports = {
  getRewardBalance,
  distributeRewards,
  getRewardPool,
};
