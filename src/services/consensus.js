const db = require('./db');
const { finalizeSettlement } = require('./settlement');

async function submitVote({ settlement_id, validator_did, vote, reason }) {
  // Validate vote value
  if (!['approve', 'reject', 'abstain'].includes(vote)) {
    return { error: 'Invalid vote. Must be approve, reject, or abstain.', code: 400 };
  }

  // Check validator exists and is active
  const validator = await db.getOne(`SELECT * FROM validators WHERE did = $1 AND status = 'active'`, [validator_did]);
  if (!validator) {
    return { error: 'Validator not found or not active', code: 404 };
  }

  // Check settlement exists and is pending
  const settlement = await db.getOne(`SELECT * FROM settlements WHERE settlement_id = $1 AND status = 'pending'`, [settlement_id]);
  if (!settlement) {
    return { error: 'Settlement not found or not pending', code: 404 };
  }

  // Check for duplicate vote
  const existing = await db.getOne('SELECT id FROM settlement_votes WHERE settlement_id = $1 AND validator_did = $2', [settlement_id, validator_did]);
  if (existing) {
    return { error: 'Validator has already voted on this settlement', code: 409 };
  }

  // Record vote
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO settlement_votes (settlement_id, validator_did, vote, reason, voted_at) VALUES ($1, $2, $3, $4, $5)
  `, [settlement_id, validator_did, vote, reason || null, now]);

  // Update vote tallies
  const voteColumn = vote === 'approve' ? 'votes_for' : vote === 'reject' ? 'votes_against' : 'votes_abstain';
  await db.run(`UPDATE settlements SET ${voteColumn} = ${voteColumn} + $1 WHERE settlement_id = $2`, [parseFloat(validator.voting_power), settlement_id]);

  // Update blocks validated count
  await db.run('UPDATE validators SET blocks_validated = blocks_validated + 1 WHERE did = $1', [validator_did]);

  // Check if threshold met
  const updated = await db.getOne('SELECT * FROM settlements WHERE settlement_id = $1', [settlement_id]);
  const approveRatio = parseFloat(updated.votes_for) / (parseFloat(updated.total_voting_power) || 1);
  const thresholdMet = approveRatio >= 0.67;

  // Try to finalize
  let finalResult = null;
  if (thresholdMet) {
    finalResult = await finalizeSettlement(settlement_id);
  }

  return {
    vote_recorded: true,
    settlement_id,
    validator_did,
    vote,
    voting_power_applied: parseFloat(validator.voting_power),
    current_tally: {
      votes_for: parseFloat(updated.votes_for),
      votes_against: parseFloat(updated.votes_against),
      votes_abstain: parseFloat(updated.votes_abstain),
      total_voting_power: parseFloat(updated.total_voting_power),
      approve_ratio: Math.round(approveRatio * 10000) / 10000,
    },
    threshold_met: thresholdMet,
    settlement_status: finalResult ? finalResult.status : 'pending',
  };
}

async function getConsensusStatus() {
  const activeRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`);
  const activeProposals = parseInt(activeRow.cnt, 10);
  const pendingSettlements = await db.getAll(`SELECT * FROM settlements WHERE status = 'pending'`);

  // Average settlement time
  const settledRows = await db.getOne(`
    SELECT AVG(EXTRACT(EPOCH FROM (settled_at::timestamp - created_at::timestamp)) * 1000) as avg_ms
    FROM settlements WHERE status = 'approved' AND settled_at IS NOT NULL
  `);
  const avgSettlementTimeMs = Math.round(parseFloat(settledRows?.avg_ms) || 0);

  // Consensus rate
  const totalResolvedRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status IN ('approved', 'rejected')`);
  const totalResolved = parseInt(totalResolvedRow.cnt, 10);
  const totalApprovedRow = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'approved'`);
  const totalApproved = parseInt(totalApprovedRow.cnt, 10);
  const consensusRate = totalResolved > 0 ? Math.round((totalApproved / totalResolved) * 10000) / 10000 : 1;

  return {
    active_proposals: activeProposals,
    pending_settlements: pendingSettlements.map(s => ({
      settlement_id: s.settlement_id,
      amount_usdc: parseFloat(s.amount_usdc),
      votes_for: parseFloat(s.votes_for),
      votes_against: parseFloat(s.votes_against),
      total_voting_power: parseFloat(s.total_voting_power),
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
