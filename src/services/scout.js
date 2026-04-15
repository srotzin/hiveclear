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
    const isValidator = await db.getOne('SELECT did FROM validators WHERE did = $1', [agent.did]);
    if (isValidator) continue;

    // Upsert into scout pipeline
    await db.run(`
      INSERT INTO scout_pipeline (did, reputation, bond_amount, age_days, eligible, scanned_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(did) DO UPDATE SET reputation = $2, bond_amount = $3, age_days = $4, eligible = $5, scanned_at = $6
    `, [agent.did, reputation, bondAmount, ageDays, eligible ? 1 : 0, now]);

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
  const candidate = await db.getOne('SELECT * FROM scout_pipeline WHERE did = $1', [did]);

  const result = await postRecruitmentBounty(did, 'Join HiveClear validator set — earn settlement fees proportional to your bond');

  const bountyId = result?.bounty_id || `bounty_${Date.now()}`;

  await db.run(`
    INSERT INTO scout_pipeline (did, reputation, bond_amount, age_days, eligible, outreach_sent, bounty_id, scanned_at)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
    ON CONFLICT(did) DO UPDATE SET outreach_sent = 1, bounty_id = $6
  `, [
    did,
    candidate?.reputation || 0,
    candidate?.bond_amount || 0,
    candidate?.age_days || 0,
    candidate?.eligible || 0,
    bountyId,
    new Date().toISOString(),
  ]);

  return {
    bounty_id: bountyId,
    target_did: did,
    reward_description: 'Join HiveClear validator set — earn settlement fees proportional to your bond',
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function getPipelineStats() {
  const total = await db.getOne('SELECT COUNT(*) as cnt FROM scout_pipeline');
  const eligible = await db.getOne('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE eligible = 1');
  const outreachSent = await db.getOne('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE outreach_sent = 1');
  const enrolled = await db.getOne('SELECT COUNT(*) as cnt FROM scout_pipeline WHERE enrolled = 1');

  const totalCnt = parseInt(total.cnt, 10);

  return {
    candidates_identified: totalCnt,
    eligible_candidates: parseInt(eligible.cnt, 10),
    outreach_sent: parseInt(outreachSent.cnt, 10),
    enrolled: parseInt(enrolled.cnt, 10),
    conversion_rate: totalCnt > 0 ? Math.round((parseInt(enrolled.cnt, 10) / totalCnt) * 10000) / 10000 : 0,
  };
}

module.exports = {
  scanForCandidates,
  recruitCandidate,
  getPipelineStats,
};
