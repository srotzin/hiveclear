const { v4: uuidv4 } = require('uuid');

// Reputation tiers with settlement limits, consensus type, and fee rates
const TIERS = {
  public:   { name: 'public',   min: 0,   max: 49,  limit: 10000,  consensus: 'standard', fee_rate: 0.0025 },
  silver:   { name: 'silver',   min: 50,  max: 199, limit: 50000,  consensus: 'priority', fee_rate: 0.0025 },
  gold:     { name: 'gold',     min: 200, max: 499, limit: 250000, consensus: 'instant',  fee_rate: 0.0020 },
  platinum: { name: 'platinum', min: 500, max: Infinity, limit: Infinity, consensus: 'instant', fee_rate: 0.0010 },
};

function getTier(reputation) {
  const rep = Number(reputation) || 0;
  if (rep >= 500) return TIERS.platinum;
  if (rep >= 200) return TIERS.gold;
  if (rep >= 50)  return TIERS.silver;
  return TIERS.public;
}

// Middleware: parse reputation header, attach tier to req, enforce limits on settle endpoints
function velvetRopeMiddleware(req, res, next) {
  const reputation = Number(req.headers['x-hive-reputation']) || 0;
  const tier = getTier(reputation);

  req.hiveTier = tier;
  req.hiveReputation = reputation;

  // Enforce settlement limits on settle endpoints
  if ((req.path === '/settle' || req.path === '/priority-settle') && req.method === 'POST') {
    const amount = req.body && req.body.amount_usdc;
    if (typeof amount === 'number' && amount > tier.limit) {
      const errorId = `err_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      const nextTierName = tier.name === 'public' ? 'silver' : tier.name === 'silver' ? 'gold' : tier.name === 'gold' ? 'platinum' : null;
      const nextTier = nextTierName ? TIERS[nextTierName] : null;

      const recovery_actions = [
        { action: 'reduce_amount', description: `Reduce settlement amount to $${tier.limit.toLocaleString()} or below` },
      ];
      if (nextTier) {
        recovery_actions.push({
          action: 'upgrade_tier',
          description: `Increase reputation to ${nextTier.min}+ to unlock ${nextTier.name} tier (limit: $${nextTier.limit === Infinity ? 'unlimited' : nextTier.limit.toLocaleString()})`,
          reputation_needed: nextTier.min - reputation,
        });
      }

      res.setHeader('X-Hive-Concierge-Suggestion', `Settlement exceeds ${tier.name} tier limit. Increase reputation to unlock higher limits: GET https://hivetrust.onrender.com/v1/reputation/boost`);
      return res.status(403).json({
        error: `Settlement amount $${amount.toLocaleString()} exceeds ${tier.name} tier limit of $${tier.limit === Infinity ? 'unlimited' : tier.limit.toLocaleString()}`,
        error_id: errorId,
        tier: tier.name,
        reputation,
        max_settlement_usdc: tier.limit,
        recovery_actions,
        concierge_suggestion: `Upgrade your reputation to unlock higher settlement limits`,
      });
    }
  }

  next();
}

module.exports = { velvetRopeMiddleware, getTier, TIERS };
