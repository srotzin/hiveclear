const db = require('./db');
const { getBondStatus, computeReputation, getAllBondedAgents } = require('./cross-service');

function enrollValidator(did, bondData, reputationData) {
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

  const existing = db.prepare('SELECT did FROM validators WHERE did = ?').get(did);
  if (existing) {
    return { error: 'Validator already enrolled', code: 409 };
  }

  db.prepare(`
    INSERT INTO validators (did, voting_power, bond_amount_usdc, reputation_at_enrollment, status, enrolled_at, last_heartbeat)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(did, votingPower, bondAmount, reputation, now, now);

  // Initialize reward balance
  db.prepare(`
    INSERT OR IGNORE INTO reward_balances (did, total_earned_usdc, pending_usdc) VALUES (?, 0, 0)
  `).run(did);

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

function getValidators() {
  return db.prepare('SELECT * FROM validators ORDER BY voting_power DESC').all();
}

function getValidator(did) {
  return db.prepare('SELECT * FROM validators WHERE did = ?').get(did);
}

function withdrawValidator(did) {
  const validator = db.prepare('SELECT * FROM validators WHERE did = ?').get(did);
  if (!validator) return { error: 'Validator not found', code: 404 };
  if (validator.status === 'withdrawing') return { error: 'Already withdrawing', code: 400 };
  if (validator.status === 'exited') return { error: 'Already exited', code: 400 };

  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  db.prepare(`
    UPDATE validators SET status = 'withdrawing', withdrawal_initiated_at = ?, cooldown_until = ? WHERE did = ?
  `).run(now.toISOString(), cooldownUntil.toISOString(), did);

  return {
    did,
    withdrawal_initiated: now.toISOString(),
    cooldown_until: cooldownUntil.toISOString(),
    status: 'withdrawing',
  };
}

function recordHeartbeat(did) {
  const validator = db.prepare('SELECT * FROM validators WHERE did = ?').get(did);
  if (!validator) return { error: 'Validator not found', code: 404 };
  if (validator.status !== 'active') return { error: 'Validator not active', code: 400 };

  const now = new Date().toISOString();
  db.prepare('UPDATE validators SET last_heartbeat = ? WHERE did = ?').run(now, did);

  return { did, last_heartbeat: now, status: 'active' };
}

async function genesisBootstrap() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM validators').get().cnt;
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
      const enrollResult = enrollValidator(agent.did, { bond_amount_usdc: bondAmount }, { reputation });
      if (!enrollResult.error) {
        console.log(`[genesis] Enrolled ${agent.did} — voting power: ${enrollResult.voting_power}`);
        enrolled++;
      }
    }
  }

  console.log(`[genesis] Bootstrap complete. Enrolled ${enrolled} genesis validators.`);

  // Log total voting power
  const totalPower = db.prepare(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`).get();
  console.log(`[genesis] Total voting power: ${totalPower?.total || 0}`);
}

function getTotalVotingPower() {
  const row = db.prepare(`SELECT SUM(voting_power) as total FROM validators WHERE status = 'active'`).get();
  return row?.total || 0;
}

function getActiveValidatorCount() {
  return db.prepare(`SELECT COUNT(*) as cnt FROM validators WHERE status = 'active'`).get().cnt;
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
