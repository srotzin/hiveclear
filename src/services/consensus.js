const db = require('./db');
const { finalizeSettlement } = require('./settlement');

function submitVote({ settlement_id, validator_did, vote, reason }) {
  // Validate vote value
  if (!['approve', 'reject', 'abstain'].includes(vote)) {
    return { error: 'Invalid vote. Must be approve, reject, or abstain.', code: 400 };
  }

  // Check validator exists and is active
  const validator = db.prepare(`SELECT * FROM validators WHERE did = ? AND status = 'active'`).get(validator_did);
  if (!validator) {
    return { error: 'Validator not found or not active', code: 404 };
  }

  // Check settlement exists and is pending
  const settlement = db.prepare(`SELECT * FROM settlements WHERE settlement_id = ? AND status = 'pending'`).get(settlement_id);
  if (!settlement) {
    return { error: 'Settlement not found or not pending', code: 404 };
  }

  // Check for duplicate vote
  const existing = db.prepare('SELECT id FROM settlement_votes WHERE settlement_id = ? AND validator_did = ?').get(settlement_id, validator_did);
  if (existing) {
    return { error: 'Validator has already voted on this settlement', code: 409 };
  }

  // Record vote
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO settlement_votes (settlement_id, validator_did, vote, reason, voted_at) VALUES (?, ?, ?, ?, ?)
  `).run(settlement_id, validator_did, vote, reason || null, now);

  // Update vote tallies
  const voteColumn = vote === 'approve' ? 'votes_for' : vote === 'reject' ? 'votes_against' : 'votes_abstain';
  db.prepare(`UPDATE settlements SET ${voteColumn} = ${voteColumn} + ? WHERE settlement_id = ?`).run(validator.voting_power, settlement_id);

  // Update blocks validated count
  db.prepare('UPDATE validators SET blocks_validated = blocks_validated + 1 WHERE did = ?').run(validator_did);

  // Check if threshold met
  const updated = db.prepare('SELECT * FROM settlements WHERE settlement_id = ?').get(settlement_id);
  const approveRatio = updated.votes_for / (updated.total_voting_power || 1);
  const thresholdMet = approveRatio >= 0.67;

  // Try to finalize
  let finalResult = null;
  if (thresholdMet) {
    finalResult = finalizeSettlement(settlement_id);
  }

  return {
    vote_recorded: true,
    settlement_id,
    validator_did,
    vote,
    voting_power_applied: validator.voting_power,
    current_tally: {
      votes_for: updated.votes_for,
      votes_against: updated.votes_against,
      votes_abstain: updated.votes_abstain,
      total_voting_power: updated.total_voting_power,
      approve_ratio: Math.round(approveRatio * 10000) / 10000,
    },
    threshold_met: thresholdMet,
    settlement_status: finalResult ? finalResult.status : 'pending',
  };
}

function getConsensusStatus() {
  const activeProposals = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`).get().cnt;
  const pendingSettlements = db.prepare(`SELECT * FROM settlements WHERE status = 'pending'`).all();

  // Average settlement time
  const settledRows = db.prepare(`
    SELECT AVG((julianday(settled_at) - julianday(created_at)) * 86400000) as avg_ms
    FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
  `).get();
  const avgSettlementTimeMs = Math.round(settledRows?.avg_ms || 0);

  // Consensus rate
  const totalResolved = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status IN ('approved', 'rejected')`).get().cnt;
  const totalApproved = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'approved'`).get().cnt;
  const consensusRate = totalResolved > 0 ? Math.round((totalApproved / totalResolved) * 10000) / 10000 : 1;

  return {
    active_proposals: activeProposals,
    pending_settlements: pendingSettlements.map(s => ({
      settlement_id: s.settlement_id,
      amount_usdc: s.amount_usdc,
      votes_for: s.votes_for,
      votes_against: s.votes_against,
      total_voting_power: s.total_voting_power,
      created_at: s.created_at,
    })),
    avg_settlement_time_ms: avgSettlementTimeMs,
    consensus_rate: consensusRate,
  };
}

module.exports = {
  submitVote,
  getConsensusStatus,
};
