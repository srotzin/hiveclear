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

  const validator = db.prepare('SELECT * FROM validators WHERE did = ?').get(validator_did);
  if (!validator) {
    return { error: 'Validator not found', code: 404 };
  }

  const rate = SLASH_RATES[reason];
  const amountSlashed = Math.round(validator.bond_amount_usdc * rate * 100) / 100;

  const slashId = `slash_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // File with HiveLaw
  const lawResult = await fileSlashingAction(validator_did, reason, evidence, amountSlashed);

  // Record slashing event
  db.prepare(`
    INSERT INTO slashing_events (slash_id, validator_did, reason, evidence, amount_slashed_usdc, hivelaw_case_id, slashed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slashId, validator_did, reason, JSON.stringify(evidence || {}), amountSlashed, lawResult?.case_id || null, now);

  // Update validator
  if (reason === 'equivocation') {
    db.prepare(`UPDATE validators SET status = 'slashed', bond_amount_usdc = 0, voting_power = 0 WHERE did = ?`).run(validator_did);
  } else {
    const newBond = Math.max(0, validator.bond_amount_usdc - amountSlashed);
    const newPower = Math.floor(newBond / 1000);
    db.prepare('UPDATE validators SET bond_amount_usdc = ?, voting_power = ? WHERE did = ?').run(newBond, newPower, validator_did);

    if (newPower < 1) {
      db.prepare(`UPDATE validators SET status = 'slashed' WHERE did = ?`).run(validator_did);
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

function getSlashingHistory() {
  return db.prepare('SELECT * FROM slashing_events ORDER BY slashed_at DESC').all();
}

function checkSlashingConditions() {
  // Check validators with low uptime
  const validators = db.prepare(`SELECT * FROM validators WHERE status = 'active'`).all();
  let slashed = 0;

  for (const v of validators) {
    if (v.uptime_pct < 99) {
      // Auto-slash for downtime
      slashValidator({
        validator_did: v.did,
        reason: 'downtime',
        evidence: { uptime_pct: v.uptime_pct, checked_at: new Date().toISOString() },
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
