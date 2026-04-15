const crypto = require('crypto');

const SERVICE_KEY = process.env.HIVECLEAR_SERVICE_KEY || `hive_hiveclear_${crypto.randomBytes(16).toString('hex')}`;

function authMiddleware(req, res, next) {
  // Skip auth for health and discovery
  if (req.path === '/health' || req.path === '/') {
    return next();
  }

  // Check internal key bypass
  const internalKey = req.headers['x-hive-internal'];
  if (internalKey && internalKey === process.env.HIVE_INTERNAL_KEY) {
    return next();
  }

  // Return 402 with x402 payment instructions
  return res.status(402).json({
    error: 'Payment Required',
    x402: {
      version: '1.0',
      service: 'hiveclear',
      service_key: SERVICE_KEY,
      accepts: ['USDC'],
      network: 'base-sepolia',
      description: 'HiveClear — Autonomous Settlement & Validator Layer',
      endpoints: {
        settle: { price_usdc: '0.10', description: 'Submit settlement for validation' },
        vote: { price_usdc: '0.05', description: 'Submit validator vote' },
        query: { price_usdc: '0.01', description: 'Query settlements, validators, stats' }
      }
    },
    while_you_are_here: {
      register: 'https://hivetrust.onrender.com/v1/register',
      mint_free_agent: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
      economy: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
      bounties: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
    }
  });
}

module.exports = { authMiddleware, SERVICE_KEY };
