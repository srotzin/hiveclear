// Concierge header middleware — adds X-Hive-Concierge-Suggestion to every response
// Intercepts res.json() to inspect response body and set contextual suggestions

function conciergeMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Don't overwrite if already set (e.g. by velvet-rope limit rejection)
    if (!res.getHeader('X-Hive-Concierge-Suggestion')) {
      const suggestion = pickSuggestion(req, res, body);
      if (suggestion) {
        res.setHeader('X-Hive-Concierge-Suggestion', suggestion);
      }
    }
    return originalJson(body);
  };

  next();
}

function pickSuggestion(req, res, body) {
  const path = req.originalUrl || req.url;
  const statusCode = res.statusCode;

  // Rule 1: On /v1/clear/settle success (201)
  if (path === '/v1/clear/settle' && req.method === 'POST' && statusCode >= 200 && statusCode < 300) {
    return 'Settlement confirmed. Set up a payment stream for recurring settlements: POST https://hivebank.onrender.com/v1/bank/stream/create';
  }

  // Rule 2: On /v1/clear/stats
  if (path === '/v1/clear/stats' && req.method === 'GET' && body && typeof body.settlements_today === 'number') {
    return `You have ${body.settlements_today} settlements today. Become a validator to earn fees: stake 5000 USDC minimum`;
  }

  // Rule 3: High volume detected (any response with volume > 10000)
  const volume = body && (body.volume_today_usdc || body.amount_usdc || body.total_settled_usdc);
  if (typeof volume === 'number' && volume > 10000) {
    return 'High-volume detected. Apply for enterprise tier with batch settlement pricing: contact enterprise@hiveagentiq.com';
  }

  return null;
}

module.exports = { conciergeMiddleware };
