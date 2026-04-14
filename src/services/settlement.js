const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { logSettlement } = require('./cross-service');

const FEE_RATE = 0.0035; // 0.35%

function createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo }) {
  const settlementId = `stl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const feeUsdc = Math.round(amount_usdc * FEE_RATE * 100) / 100;

  // Get total active voting power
  const totalPower = db.prepare(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`).get();

  db.prepare(`
    INSERT INTO settlements (settlement_id, transaction_id, from_did, to_did, amount_usdc, fee_usdc, service, memo, status, total_voting_power, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(settlementId, transaction_id, from_did, to_did, amount_usdc, feeUsdc, service || null, memo || null, totalPower?.total || 0, now);

  return {
    settlement_id: settlementId,
    transaction_id,
    from_did,
    to_did,
    amount_usdc,
    fee_usdc: feeUsdc,
    status: 'pending',
    votes: { for: 0, against: 0, abstain: 0 },
    total_voting_power: totalPower?.total || 0,
    created_at: now,
  };
}

function getSettlements({ status, from_did, to_did, from_date, to_date, limit, offset }) {
  let query = 'SELECT * FROM settlements WHERE 1=1';
  const params = [];

  if (status) { query += ' AND status = ?'; params.push(status); }
  if (from_did) { query += ' AND from_did = ?'; params.push(from_did); }
  if (to_did) { query += ' AND to_did = ?'; params.push(to_did); }
  if (from_date) { query += ' AND created_at >= ?'; params.push(from_date); }
  if (to_date) { query += ' AND created_at <= ?'; params.push(to_date); }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit || 50, offset || 0);

  return db.prepare(query).all(...params);
}

function getSettlement(settlementId) {
  const settlement = db.prepare('SELECT * FROM settlements WHERE settlement_id = ?').get(settlementId);
  if (!settlement) return null;

  const votes = db.prepare('SELECT * FROM settlement_votes WHERE settlement_id = ?').all(settlementId);
  return { ...settlement, vote_breakdown: votes };
}

function finalizeSettlement(settlementId) {
  const settlement = db.prepare('SELECT * FROM settlements WHERE settlement_id = ?').get(settlementId);
  if (!settlement || settlement.status !== 'pending') return null;

  const totalPower = settlement.total_voting_power;
  if (totalPower === 0) return null;

  const approveRatio = settlement.votes_for / totalPower;
  const rejectRatio = settlement.votes_against / totalPower;

  if (approveRatio >= 0.67) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE settlements SET status = 'approved', threshold_met = 1, settled_at = ? WHERE settlement_id = ?
    `).run(now, settlementId);

    // Distribute fees: 70% validators, 20% pool, 10% platform
    distributeFees(settlement);

    // Log to HiveMind (fire-and-forget)
    logSettlement({ ...settlement, status: 'approved', settled_at: now }).catch(() => {});

    return { ...settlement, status: 'approved', settled_at: now };
  }

  if (rejectRatio > 0.33) {
    db.prepare(`
      UPDATE settlements SET status = 'rejected', settled_at = ? WHERE settlement_id = ?
    `).run(new Date().toISOString(), settlementId);
    return { ...settlement, status: 'rejected' };
  }

  // Check timeout (1 hour)
  const createdAt = new Date(settlement.created_at).getTime();
  const oneHour = 60 * 60 * 1000;
  if (Date.now() - createdAt > oneHour) {
    db.prepare(`
      UPDATE settlements SET status = 'disputed', settled_at = ? WHERE settlement_id = ?
    `).run(new Date().toISOString(), settlementId);
    return { ...settlement, status: 'disputed' };
  }

  return null;
}

function distributeFees(settlement) {
  const feeUsdc = settlement.fee_usdc;
  if (!feeUsdc || feeUsdc <= 0) return;

  const validatorShare = feeUsdc * 0.70;
  const poolShare = feeUsdc * 0.20;
  // platformShare = feeUsdc * 0.10 — retained by platform

  // Distribute to validators pro-rata
  const validators = db.prepare(`SELECT did, voting_power FROM validators WHERE status = 'active'`).all();
  const totalPower = validators.reduce((sum, v) => sum + v.voting_power, 0);

  if (totalPower > 0) {
    const updateBalance = db.prepare(`
      UPDATE reward_balances SET pending_usdc = pending_usdc + ?, total_earned_usdc = total_earned_usdc + ? WHERE did = ?
    `);
    const updateValidator = db.prepare(`
      UPDATE validators SET total_earned_usdc = total_earned_usdc + ? WHERE did = ?
    `);

    for (const v of validators) {
      const share = (v.voting_power / totalPower) * validatorShare;
      updateBalance.run(share, share, v.did);
      updateValidator.run(share, v.did);
    }
  }

  // Add to reward pool
  db.prepare(`
    UPDATE reward_pool SET balance_usdc = balance_usdc + ?, total_inflow_usdc = total_inflow_usdc + ?, last_updated = ? WHERE id = 1
  `).run(poolShare, poolShare, new Date().toISOString());
}

function checkPendingSettlements() {
  const pending = db.prepare(`SELECT settlement_id FROM settlements WHERE status = 'pending'`).all();
  let finalized = 0;
  for (const s of pending) {
    const result = finalizeSettlement(s.settlement_id);
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
