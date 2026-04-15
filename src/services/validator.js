const db = require('./db');
const { getBondStatus, computeReputation, getAllBondedAgents } = require('./cross-service');

async function enrollValidator(did, bondData, reputationData) {
  const now = new Date().toISOString();
  const bondAmount = bondData?.bond_amount_usdc || bondData?.bond_amount || 0;
  const reputation = reputationData?.reputation || reputationData?.score || 0;
  const votingPower = Math.floor(bondAmount / 1000);

  if (votingPower < 1) {
    return { error: 'Insufficient bond amount. Minimum $1,000 required.', code: 400 };
  }
  if (reputation < 500) {
    return { error: 'Insufficient reputation. Minimum 500 required.', code: 400 };
  }

  const existing = await db.getOne('SELECT did FROM validators WHERE did = $1', [did]);
  if (existing) {
    return { error: 'Validator already enrolled', code: 409 };
  }

  await db.run(`
    INSERT INTO validators (did, voting_power, bond_amount_usdc, reputation_at_enrollment, status, enrolled_at, last_heartbeat)
    VALUES ($1, $2, $3, $4, 'active', $5, $6)
  `, [did, votingPower, bondAmount, reputation, now, now]);

  // Initialize reward balance
  await db.run(`
    INSERT INTO reward_balances (did, total_earned_usdc, pending_usdc) VALUES ($1, 0, 0)
    ON CONFLICT (did) DO NOTHING
  `, [did]);

  return {
    validator_id: did,
    did,
    voting_power: votingPower,
    bond_amount_usdc: bondAmount,
    reputation: reputation,
    status: 'active',
    enrolled_at: now,
  };
}

async function enrollValidatorFromDid(did) {
  const bondData = await getBondStatus(did);
  const reputationData = await computeReputation(did);

  // Use fallback data if cross-service calls fail
  const bond = bondData || { bond_amount_usdc: 0 };
  const rep = reputationData || { reputation: 0 };

  return enrollValidator(did, bond, rep);
}

async function getValidators() {
  return db.getAll('SELECT * FROM validators ORDER BY voting_power DESC');
}

async function getValidator(did) {
  return db.getOne('SELECT * FROM validators WHERE did = $1', [did]);
}

async function withdrawValidator(did) {
  const validator = await db.getOne('SELECT * FROM validators WHERE did = $1', [did]);
  if (!validator) return { error: 'Validator not found', code: 404 };
  if (validator.status === 'withdrawing') return { error: 'Already withdrawing', code: 400 };
  if (validator.status === 'exited') return { error: 'Already exited', code: 400 };

  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.run(`
    UPDATE validators SET status = 'withdrawing', withdrawal_initiated_at = $1, cooldown_until = $2 WHERE did = $3
  `, [now.toISOString(), cooldownUntil.toISOString(), did]);

  return {
    did,
    withdrawal_initiated: now.toISOString(),
    cooldown_until: cooldownUntil.toISOString(),
    status: 'withdrawing',
  };
}

async function recordHeartbeat(did) {
  const validator = await db.getOne('SELECT * FROM validators WHERE did = $1', [did]);
  if (!validator) return { error: 'Validator not found', code: 404 };
  if (validator.status !== 'active') return { error: 'Validator not active', code: 400 };

  const now = new Date().toISOString();
  await db.run('UPDATE validators SET last_heartbeat = $1 WHERE did = $2', [now, did]);

  return { did, last_heartbeat: now, status: 'active' };
}

async function genesisBootstrap() {
  const countRow = await db.getOne('SELECT COUNT(*) as cnt FROM validators');
  const count = parseInt(countRow.cnt, 10);
  if (count > 0) {
    console.log('[genesis] Validators already exist, skipping bootstrap');
    return;
  }

  console.log('[genesis] No validators found. Starting genesis bootstrap...');

  const result = await getAllBondedAgents();
  const agents = result?.agents || result || [];

  let enrolled = 0;
  for (const agent of agents) {
    const bondAmount = agent.bond_amount_usdc || agent.bond_amount || 0;
    const reputation = agent.reputation || agent.score || 0;

    if (reputation >= 500 && bondAmount >= 1000) {
      const enrollResult = await enrollValidator(agent.did, { bond_amount_usdc: bondAmount }, { reputation });
      if (!enrollResult.error) {
        console.log(`[genesis] Enrolled ${agent.did} — voting power: ${enrollResult.voting_power}`);
        enrolled++;
      }
    }
  }

  console.log(`[genesis] Bootstrap complete. Enrolled ${enrolled} genesis validators.`);

  // Log total voting power
  const totalPower = await db.getOne(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`);
  console.log(`[genesis] Total voting power: ${totalPower?.total || 0}`);
}

async function getTotalVotingPower() {
  const row = await db.getOne(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`);
  return parseFloat(row?.total) || 0;
}

async function getActiveValidatorCount() {
  const row = await db.getOne(`SELECT COUNT(*) as cnt FROM validators WHERE status = 'active'`);
  return parseInt(row.cnt, 10);
}

module.exports = {
  enrollValidator,
  enrollValidatorFromDid,
  getValidators,
  getValidator,
  withdrawValidator,
  recordHeartbeat,
  genesisBootstrap,
  getTotalVotingPower,
  getActiveValidatorCount,
};
