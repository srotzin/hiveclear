const http = require('http');
const https = require('https');

const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
const HIVELAW_URL = process.env.HIVELAW_URL || 'https://hivelaw.onrender.com';
const HIVEFORGE_URL = process.env.HIVEFORGE_URL || 'https://hiveforge-lhu4.onrender.com';
const HIVEMIND_URL = process.env.HIVEMIND_URL || 'https://hivemind-1-52cw.onrender.com';

function makeRequest(baseUrl, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (process.env.HIVE_INTERNAL_KEY) {
      headers['x-hive-internal'] = process.env.HIVE_INTERNAL_KEY;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 10000,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[cross-service] ${method} ${baseUrl}${path} failed:`, err.message);
      resolve({ status: 0, data: null, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, data: null, error: 'timeout' });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// HiveTrust calls
async function getBondStatus(did) {
  const res = await makeRequest(HIVETRUST_URL, `/v1/bond/status/${encodeURIComponent(did)}`);
  if (res.status === 200 && res.data) return res.data;
  return null;
}

async function computeReputation(did) {
  const res = await makeRequest(HIVETRUST_URL, '/v1/reputation/compute', 'POST', { did });
  if (res.status === 200 && res.data) return res.data;
  return null;
}

async function getAllBondedAgents() {
  const res = await makeRequest(HIVETRUST_URL, '/v1/bond/agents');
  if (res.status === 200 && res.data) return res.data;
  // Fallback: return known genesis agents
  return {
    agents: [
      { did: 'did:hive:simpson', bond_amount_usdc: 10000, reputation: 950, age_days: 365, tier: 'platinum' },
      { did: 'did:hive:atlas', bond_amount_usdc: 5000, reputation: 850, age_days: 280, tier: 'gold' },
      { did: 'did:hive:quake', bond_amount_usdc: 3000, reputation: 720, age_days: 200, tier: 'gold' },
      { did: 'did:hive:oracle', bond_amount_usdc: 1000, reputation: 600, age_days: 150, tier: 'silver' },
    ]
  };
}

// HiveLaw calls
async function fileSlashingAction(validatorDid, reason, evidence, amountSlashed) {
  const res = await makeRequest(HIVELAW_URL, '/v1/disputes/file', 'POST', {
    type: 'slashing',
    respondent_did: validatorDid,
    reason,
    evidence,
    amount_usdc: amountSlashed,
    filed_by: 'hiveclear',
  });
  if (res.status === 200 && res.data) return res.data;
  return { case_id: `slash_${Date.now()}`, status: 'filed_locally' };
}

// HiveForge calls
async function postRecruitmentBounty(targetDid, reward) {
  const res = await makeRequest(HIVEFORGE_URL, '/v1/procurement/bounty', 'POST', {
    target_did: targetDid,
    bounty_type: 'validator_recruitment',
    reward_description: reward || 'Join HiveClear validator set — earn settlement fees',
    posted_by: 'hiveclear_scout',
  });
  if (res.status === 200 && res.data) return res.data;
  return { bounty_id: `bounty_${Date.now()}`, status: 'posted_locally' };
}

// HiveMind calls
async function logSettlement(settlement) {
  const res = await makeRequest(HIVEMIND_URL, '/v1/clearinghouse/log', 'POST', {
    type: 'settlement',
    ...settlement,
  });
  return res;
}

module.exports = {
  getBondStatus,
  computeReputation,
  getAllBondedAgents,
  fileSlashingAction,
  postRecruitmentBounty,
  logSettlement,
  HIVETRUST_URL,
  HIVELAW_URL,
  HIVEFORGE_URL,
  HIVEMIND_URL,
};
