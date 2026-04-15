const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { fileSlashingAction } = require('./cross-service');

const SLASH_RATES = {
  downtime: 0.001,       // 0.1% of stake
  equivocation: 1.0,     // 100% of stake
  censorship: 0.5,       // 50% of stake
};

async function slashValidator({ validator_did, reason, evidence }) {
  if (!SLASH_RATES[reason]) {
    return { error: 'Invalid reason. Must be downtime, equivocation, or censorship.', code: 400 };
  }

  const validator = await db.getOne('SELECT * FROM validators WHERE did = $1', [validator_did]);
  if (!validator) {
    return { error: 'Validator not found', code: 404 };
  }

  const rate = SLASH_RATES[reason];
  const amountSlashed = Math.round(parseFloat(validator.bond_amount_usdc) * rate * 100) / 100;

  const slashId = `slash_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // File with HiveLaw
  const lawResult = await fileSlashingAction(validator_did, reason, evidence, amountSlashed);

  // Record slashing event
  await db.run(`
    INSERT INTO slashing_events (slash_id, validator_did, reason, evidence, amount_slashed_usdc, hivelaw_case_id, slashed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [slashId, validator_did, reason, JSON.stringify(evidence || {}), amountSlashed, lawResult?.case_id || null, now]);

  // Update validator
  if (reason === 'equivocation') {
    await db.run(`UPDATE validators SET status = 'slashed', bond_amount_usdc = 0, voting_power = 0 WHERE did = $1`, [validator_did]);
  } else {
    const newBond = Math.max(0, parseFloat(validator.bond_amount_usdc) - amountSlashed);
    const newPower = Math.floor(newBond / 1000);
    await db.run('UPDATE validators SET bond_amount_usdc = $1, voting_power = $2 WHERE did = $3', [newBond, newPower, validator_did]);

    if (newPower < 1) {
      await db.run(`UPDATE validators SET status = 'slashed' WHERE did = $1`, [validator_did]);
    }
  }

  return {
    slash_id: slashId,
    validator_did,
    reason,
    amount_slashed_usdc: amountSlashed,
    enforced_by: 'hivelaw',
    hivelaw_case_id: lawResult?.case_id || null,
    slashed_at: now,
  };
}

async function getSlashingHistory() {
  return db.getAll('SELECT * FROM slashing_events ORDER BY slashed_at DESC');
}

async function checkSlashingConditions() {
  // Check validators with low uptime
  const validators = await db.getAll(`SELECT * FROM validators WHERE status = 'active'`);
  let slashed = 0;

  for (const v of validators) {
    if (parseFloat(v.uptime_pct) < 99) {
      // Auto-slash for downtime
      slashValidator({
        validator_did: v.did,
        reason: 'downtime',
        evidence: { uptime_pct: parseFloat(v.uptime_pct), checked_at: new Date().toISOString() },
      }).then(result => {
        if (!result.error) {
          console.log(`[slashing-enforcer] Slashed ${v.did} for downtime (uptime: ${v.uptime_pct}%)`);
        }
      }).catch(() => {});
      slashed++;
    }
  }

  if (slashed > 0) {
    console.log(`[slashing-enforcer] Checked ${validators.length} validators, slashed ${slashed}`);
  }
}

module.exports = {
  slashValidator,
  getSlashingHistory,
  checkSlashingConditions,
  SLASH_RATES,
};
