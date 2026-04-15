const { v4: uuidv4 } = require('uuid');
const db = require('./db');

async function getRewardBalance(did) {
  const balance = await db.getOne('SELECT * FROM reward_balances WHERE did = $1', [did]);
  if (!balance) {
    return { did, total_earned_usdc: 0, pending_usdc: 0, last_distribution: null, breakdown: { settlement_fees: 0, pool_rewards: 0 } };
  }

  // Get breakdown from distributions
  const distributions = await db.getAll(`
    SELECT distribution_details FROM reward_distributions ORDER BY distributed_at DESC LIMIT 10
  `);

  let poolRewards = 0;
  for (const d of distributions) {
    try {
      const details = JSON.parse(d.distribution_details || '[]');
      const entry = details.find(e => e.did === did);
      if (entry) poolRewards += entry.amount;
    } catch {}
  }

  const totalEarned = parseFloat(balance.total_earned_usdc);
  const pendingUsdc = parseFloat(balance.pending_usdc);

  return {
    did,
    total_earned_usdc: Math.round(totalEarned * 100) / 100,
    pending_usdc: Math.round(pendingUsdc * 100) / 100,
    last_distribution: balance.last_distribution_at,
    breakdown: {
      settlement_fees: Math.round((totalEarned - poolRewards) * 100) / 100,
      pool_rewards: Math.round(poolRewards * 100) / 100,
    },
  };
}

async function distributeRewards() {
  const pool = await db.getOne('SELECT * FROM reward_pool WHERE id = 1');
  if (!pool || parseFloat(pool.balance_usdc) <= 0) {
    return { distribution_id: null, total_distributed_usdc: 0, validators_paid: 0, message: 'No funds in pool' };
  }

  const validators = await db.getAll(`SELECT did, voting_power FROM validators WHERE status = 'active'`);
  const totalPower = validators.reduce((sum, v) => sum + parseFloat(v.voting_power), 0);
  if (totalPower === 0 || validators.length === 0) {
    return { distribution_id: null, total_distributed_usdc: 0, validators_paid: 0, message: 'No active validators' };
  }

  const distributionId = `dist_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const amountToDistribute = parseFloat(pool.balance_usdc);
  const details = [];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    for (const v of validators) {
      const share = (parseFloat(v.voting_power) / totalPower) * amountToDistribute;
      const rounded = Math.round(share * 100) / 100;
      await client.query(
        `UPDATE reward_balances SET pending_usdc = pending_usdc + $1, total_earned_usdc = total_earned_usdc + $2, last_distribution_at = $3 WHERE did = $4`,
        [rounded, rounded, now, v.did]
      );
      await client.query(
        `UPDATE validators SET total_earned_usdc = total_earned_usdc + $1 WHERE did = $2`,
        [rounded, v.did]
      );
      details.push({ did: v.did, voting_power: parseFloat(v.voting_power), amount: rounded });
    }

    await client.query(
      `UPDATE reward_pool SET balance_usdc = 0, total_distributed_usdc = total_distributed_usdc + $1, last_updated = $2 WHERE id = 1`,
      [amountToDistribute, now]
    );

    await client.query(
      `INSERT INTO reward_distributions (distribution_id, total_distributed_usdc, validators_paid, distribution_details, distributed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [distributionId, amountToDistribute, validators.length, JSON.stringify(details), now]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`[reward-distributor] Distributed $${amountToDistribute.toFixed(2)} to ${validators.length} validators`);

  return {
    distribution_id: distributionId,
    total_distributed_usdc: Math.round(amountToDistribute * 100) / 100,
    validators_paid: validators.length,
    timestamp: now,
  };
}

async function getRewardPool() {
  const pool = await db.getOne('SELECT * FROM reward_pool WHERE id = 1');
  const lastDist = await db.getOne('SELECT distributed_at FROM reward_distributions ORDER BY distributed_at DESC LIMIT 1');

  // Estimate daily inflow from recent settlements
  const recentFees = await db.getOne(`
    SELECT SUM(fee_usdc) as total FROM settlements
    WHERE status = 'approved' AND settled_at >= (NOW() - INTERVAL '1 day')::text
  `);
  const dailyInflow = (parseFloat(recentFees?.total) || 0) * 0.20; // 20% of fees go to pool

  return {
    pool_balance_usdc: Math.round((parseFloat(pool?.balance_usdc) || 0) * 100) / 100,
    daily_inflow_usdc: Math.round(dailyInflow * 100) / 100,
    next_distribution: lastDist ? new Date(new Date(lastDist.distributed_at).getTime() + 24 * 60 * 60 * 1000).toISOString() : 'pending',
    total_distributed_usdc: Math.round((parseFloat(pool?.total_distributed_usdc) || 0) * 100) / 100,
  };
}

module.exports = {
  getRewardBalance,
  distributeRewards,
  getRewardPool,
};
