const db = require('./db');
const { getAllBondedAgents, postRecruitmentBounty } = require('./cross-service');

async function scanForCandidates() {
  const result = await getAllBondedAgents();
  const agents = result?.agents || result || [];
  const candidates = [];

  const now = new Date().toISOString();

  for (const agent of agents) {
    const bondAmount = agent.bond_amount_usdc || agent.bond_amount || 0;
    const reputation = agent.reputation || agent.score || 0;
    const ageDays = agent.age_days || 0;
    const eligible = reputation >= 500 && bondAmount >= 1000 && ageDays >= 30;

    // Check if already a validator
    const isValidator = db.prepare('SELECT did FROM validators WHERE did = ?').get(agent.did);
    if (isValidator) continue;

    // Upsert into scout pipeline
    db.prepare(`
      INSERT INTO scout_pipeline (did, reputation, bond_amount, age_days, eligible, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET reputation = ?, bond_amount = ?, age_days = ?, eligible = ?, scanned_at = ?
    `).run(agent.did, reputation, bondAmount, ageDays, eligible ? 1 : 0, now,
           reputation, bondAmount, ageDays, eligible ? 1 : 0, now);

    candidates.push({
      did: agent.did,
      reputation,
      bond_amount: bondAmount,
      age_days: ageDays,
      eligible,
    });
  }

  console.log(`[scout] Scanned ${agents.length} agents, found ${candidates.filter(c => c.eligible).length} eligible candidates`);

  return { candidates };
}

async function recruitCandidate(did) {
  const candidate = db.prepare('SELECT * FROM scout_pipeline WHERE did = ?').get(did);

  const result = await postRecruitmentBounty(did, 'Join HiveClear validator set — earn settlement fees proportional to your bond');

  const bountyId = result?.bounty_id || `bounty_${Date.now()}`;

  db.prepare(`
    INSERT INTO scout_pipeline (did, reputation, bond_amount, age_days, eligible, outreach_sent, bounty_id, scanned_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(did) DO UPDATE SET outreach_sent = 1, bounty_id = ?
  `).run(
    did,
    candidate?.reputation || 0,
    candidate?.bond_amount || 0,
    candidate?.age_days || 0,
    candidate?.eligible || 0,
    bountyId,
    new Date().toISOString(),
    bountyId
  );

  return {
    bounty_id: bountyId,
    target_did: did,
    reward_description: 'Join HiveClear validator set — earn settlement fees proportional to your bond',
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function getPipelineStats() {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM scout_pipeline').get().cnt;
  const eligible = db.prepare('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE eligible = 1').get().cnt;
  const outreachSent = db.prepare('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE outreach_sent = 1').get().cnt;
  const enrolled = db.prepare('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE enrolled = 1').get().cnt;

  return {
    candidates_identified: total,
    eligible_candidates: eligible,
    outreach_sent: outreachSent,
    enrolled,
    conversion_rate: total > 0 ? Math.round((enrolled / total) * 10000) / 10000 : 0,
  };
}

module.exports = {
  scanForCandidates,
  recruitCandidate,
  getPipelineStats,
};
