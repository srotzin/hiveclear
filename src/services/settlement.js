const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { logSettlement } = require('./cross-service');

const FEE_RATE = 0.0025; // 0.25%

async function createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo, fee_rate }) {
  const settlementId = `stl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const effectiveRate = typeof fee_rate === 'number' ? fee_rate : FEE_RATE;
  const feeUsdc = Math.max(0.05, Math.round(amount_usdc * effectiveRate * 100) / 100);

  // Get total active voting power
  const totalPower = await db.getOne(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`);

  await db.run(`
    INSERT INTO settlements (settlement_id, transaction_id, from_did, to_did, amount_usdc, fee_usdc, service, memo, status, total_voting_power, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
  `, [settlementId, transaction_id, from_did, to_did, amount_usdc, feeUsdc, service || null, memo || null, parseFloat(totalPower?.total) || 0, now]);

  return {
    settlement_id: settlementId,
    transaction_id,
    from_did,
    to_did,
    amount_usdc,
    fee_usdc: feeUsdc,
    status: 'pending',
    votes: { for: 0, against: 0, abstain: 0 },
    total_voting_power: parseFloat(totalPower?.total) || 0,
    created_at: now,
  };
}

async function getSettlements({ status, from_did, to_did, from_date, to_date, limit, offset }) {
  let query = 'SELECT * FROM settlements WHERE 1=1';
  const params = [];
  let idx = 1;

  if (status) { query += ` AND status = $${idx++}`; params.push(status); }
  if (from_did) { query += ` AND from_did = $${idx++}`; params.push(from_did); }
  if (to_did) { query += ` AND to_did = $${idx++}`; params.push(to_did); }
  if (from_date) { query += ` AND created_at >= $${idx++}`; params.push(from_date); }
  if (to_date) { query += ` AND created_at <= $${idx++}`; params.push(to_date); }

  query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit || 50, offset || 0);

  return db.getAll(query, params);
}

async function getSettlement(settlementId) {
  const settlement = await db.getOne('SELECT * FROM settlements WHERE settlement_id = $1', [settlementId]);
  if (!settlement) return null;

  const votes = await db.getAll('SELECT * FROM settlement_votes WHERE settlement_id = $1', [settlementId]);
  return { ...settlement, vote_breakdown: votes };
}

async function finalizeSettlement(settlementId) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [settlement] } = await client.query(
      'SELECT * FROM settlements WHERE settlement_id = $1 AND status = $2 FOR UPDATE',
      [settlementId, 'pending']
    );
    if (!settlement) {
      await client.query('ROLLBACK');
      return null;
    }

    const totalPower = parseFloat(settlement.total_voting_power);
    if (totalPower === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const approveRatio = parseFloat(settlement.votes_for) / totalPower;
    const rejectRatio = parseFloat(settlement.votes_against) / totalPower;

    if (approveRatio >= 0.67) {
      const now = new Date().toISOString();
      await client.query(
        `UPDATE settlements SET status = 'approved', threshold_met = 1, settled_at = $1 WHERE settlement_id = $2`,
        [now, settlementId]
      );

      // Distribute fees within the same transaction
      await distributeFeesInTx(client, settlement);

      await client.query('COMMIT');

      // Log to HiveMind (fire-and-forget)
      logSettlement({ ...settlement, status: 'approved', settled_at: now }).catch(() => {});

      return { ...settlement, status: 'approved', settled_at: now };
    }

    if (rejectRatio > 0.33) {
      const now = new Date().toISOString();
      await client.query(
        `UPDATE settlements SET status = 'rejected', settled_at = $1 WHERE settlement_id = $2`,
        [now, settlementId]
      );
      await client.query('COMMIT');
      return { ...settlement, status: 'rejected' };
    }

    // Check timeout (1 hour)
    const createdAt = new Date(settlement.created_at).getTime();
    const oneHour = 60 * 60 * 1000;
    if (Date.now() - createdAt > oneHour) {
      const now = new Date().toISOString();
      await client.query(
        `UPDATE settlements SET status = 'disputed', settled_at = $1 WHERE settlement_id = $2`,
        [now, settlementId]
      );
      await client.query('COMMIT');
      return { ...settlement, status: 'disputed' };
    }

    await client.query('ROLLBACK');
    return null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function distributeFeesInTx(client, settlement) {
  const feeUsdc = parseFloat(settlement.fee_usdc);
  if (!feeUsdc || feeUsdc <= 0) return;

  const validatorShare = feeUsdc * 0.70;
  const poolShare = feeUsdc * 0.20;
  // platformShare = feeUsdc * 0.10 — retained by platform

  // Distribute to validators pro-rata
  const { rows: validators } = await client.query(
    `SELECT did, voting_power FROM validators WHERE status = 'active'`
  );
  const totalPower = validators.reduce((sum, v) => sum + parseFloat(v.voting_power), 0);

  if (totalPower > 0) {
    for (const v of validators) {
      const share = (parseFloat(v.voting_power) / totalPower) * validatorShare;
      await client.query(
        `UPDATE reward_balances SET pending_usdc = pending_usdc + $1, total_earned_usdc = total_earned_usdc + $2 WHERE did = $3`,
        [share, share, v.did]
      );
      await client.query(
        `UPDATE validators SET total_earned_usdc = total_earned_usdc + $1 WHERE did = $2`,
        [share, v.did]
      );
    }
  }

  // Add to reward pool
  await client.query(
    `UPDATE reward_pool SET balance_usdc = balance_usdc + $1, total_inflow_usdc = total_inflow_usdc + $2, last_updated = $3 WHERE id = 1`,
    [poolShare, poolShare, new Date().toISOString()]
  );
}

async function checkPendingSettlements() {
  // Priority settlements processed first
  const pending = await db.getAll(`SELECT settlement_id FROM settlements WHERE status = 'pending' ORDER BY priority DESC, created_at ASC`);
  let finalized = 0;
  for (const s of pending) {
    const result = await finalizeSettlement(s.settlement_id);
    if (result) finalized++;
  }
  if (finalized > 0) {
    console.log(`[settlement-finalizer] Finalized ${finalized} settlements`);
  }
}

module.exports = {
  createSettlement,
  getSettlements,
  getSettlement,
  finalizeSettlement,
  checkPendingSettlements,
  FEE_RATE,
};
