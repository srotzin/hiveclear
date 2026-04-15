const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';

// White-glove error factory: transforms standard errors into rich, actionable responses
// Call these in route handlers instead of bare res.status(x).json({ error: ... })

function generateErrorId() {
  return `err_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
}

function insufficientFunds(res, { amount_usdc, available_usdc, from_did }) {
  const errorId = generateErrorId();
  const deficit = Math.round((amount_usdc - (available_usdc || 0)) * 100) / 100;

  // Pre-signed x402 top-up payload
  const x402TopUp = {
    version: '1.0',
    type: 'top-up',
    currency: 'USDC',
    network: 'base-sepolia',
    amount_usdc: deficit,
    recipient: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    memo: `Top-up for settlement deficit — ${errorId}`,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };

  res.setHeader('X-Hive-Concierge-Suggestion', `Insufficient funds. Deposit ${deficit} USDC to continue: ${HIVEBANK_URL}/v1/bank/vault/deposit`);
  return res.status(402).json({
    error: 'Insufficient funds for settlement',
    error_id: errorId,
    deficit_usdc: deficit,
    amount_requested_usdc: amount_usdc,
    available_usdc: available_usdc || 0,
    recovery_actions: [
      {
        action: 'deposit_funds',
        description: `Deposit at least ${deficit} USDC to your vault`,
        url: `${HIVEBANK_URL}/v1/bank/vault/deposit`,
        method: 'POST',
        payload: { from_did, amount_usdc: deficit, currency: 'USDC' },
      },
      {
        action: 'x402_top_up',
        description: 'Use pre-signed x402 payment to top up instantly',
        x402_payload: x402TopUp,
      },
      {
        action: 'micro_loan',
        description: `Temporary micro-loan available: borrow up to $${Math.min(deficit * 1.5, 5000).toFixed(2)} USDC at 0.5% daily rate`,
        url: `${HIVEBANK_URL}/v1/bank/loans/micro`,
        method: 'POST',
        payload: { borrower_did: from_did, amount_usdc: deficit, term_hours: 24 },
        terms: { rate_daily_pct: 0.5, max_term_hours: 72, auto_repay: true },
      },
    ],
    concierge_suggestion: `Deposit funds or take a micro-loan to cover the ${deficit} USDC deficit`,
    while_you_are_here: {
      register: 'https://hivetrust.onrender.com/v1/register',
      mint_free_agent: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
      economy: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
      bounties: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
    },
  });
}

function missingFields(res, { missing, endpoint }) {
  const errorId = generateErrorId();

  const fieldDescriptions = {
    from_did: { description: 'DID of the sending agent', type: 'string', example: 'did:hive:agent:sender123' },
    to_did: { description: 'DID of the receiving agent', type: 'string', example: 'did:hive:agent:receiver456' },
    amount_usdc: { description: 'Settlement amount in USDC (must be positive)', type: 'number', example: 100.50 },
    transaction_id: { description: 'Optional external transaction reference', type: 'string', example: 'tx_abc123' },
    service: { description: 'Optional service identifier', type: 'string', example: 'compute' },
    memo: { description: 'Optional memo for the settlement', type: 'string', example: 'Payment for API usage' },
    settlement_id: { description: 'ID of the settlement to vote on', type: 'string', example: 'stl_abc123def456' },
    validator_did: { description: 'DID of the voting validator', type: 'string', example: 'did:hive:validator:v001' },
    vote: { description: 'Vote value', type: 'string', enum: ['approve', 'reject', 'abstain'], example: 'approve' },
  };

  const required_fields = missing.map(field => ({
    field,
    ...(fieldDescriptions[field] || { description: `Required field: ${field}`, type: 'string' }),
  }));

  // Build example payload from field descriptions
  const example_payload = {};
  for (const field of missing) {
    const desc = fieldDescriptions[field];
    example_payload[field] = desc ? desc.example : `<${field}>`;
  }

  res.setHeader('X-Hive-Concierge-Suggestion', `Missing required fields: ${missing.join(', ')}. See required_fields in response for descriptions and examples.`);
  return res.status(400).json({
    error: `Missing required fields: ${missing.join(', ')}`,
    error_id: errorId,
    required_fields,
    example_payload,
    endpoint: endpoint || req.originalUrl,
    recovery_actions: [
      {
        action: 'resubmit',
        description: `Resubmit with all required fields: ${missing.join(', ')}`,
      },
      {
        action: 'view_docs',
        description: 'View API documentation for field requirements',
        url: 'https://hiveclear.onrender.com/.well-known/ai-plugin.json',
      },
    ],
    concierge_suggestion: `Include all required fields and resubmit. See example_payload for a template.`,
  });
}

function consensusFailure(res, { settlement_id, reason }) {
  const errorId = generateErrorId();
  const retryAfterMs = 30000;

  res.setHeader('X-Hive-Concierge-Suggestion', `Consensus failed for ${settlement_id}. Retry in 30s or escalate to protocol@hiveagentiq.com`);
  return res.status(503).json({
    error: reason || 'Consensus could not be reached',
    error_id: errorId,
    settlement_id,
    recovery_actions: [
      {
        action: 'retry',
        description: `Retry settlement after ${retryAfterMs / 1000} seconds`,
        retry_after_ms: retryAfterMs,
        retry_at: new Date(Date.now() + retryAfterMs).toISOString(),
      },
      {
        action: 'alternative_validators',
        description: 'Request routing to alternative validator set',
        url: 'https://hiveclear.onrender.com/v1/clear/validators',
        method: 'GET',
        note: 'Select validators with highest uptime_pct for priority consensus',
      },
      {
        action: 'escalate',
        description: 'Escalate to protocol governance for manual resolution',
        contact: 'protocol@hiveagentiq.com',
        escalation_url: 'https://hivelaw.onrender.com/v1/law/cases',
        method: 'POST',
        payload: { type: 'consensus_failure', settlement_id, error_id: errorId },
      },
    ],
    concierge_suggestion: `Consensus failed. Wait ${retryAfterMs / 1000}s and retry, or escalate for manual resolution.`,
  });
}

function serverError(res, { message, context }) {
  const errorId = generateErrorId();

  res.setHeader('X-Hive-Concierge-Suggestion', `Internal error occurred. Reference ${errorId} when contacting support: protocol@hiveagentiq.com`);
  return res.status(500).json({
    error: message || 'Internal server error',
    error_id: errorId,
    recovery_actions: [
      {
        action: 'retry',
        description: 'Retry the request after a brief pause',
        retry_after_ms: 5000,
      },
      {
        action: 'contact_support',
        description: `Contact support with error reference: ${errorId}`,
        contact: 'protocol@hiveagentiq.com',
      },
    ],
    concierge_suggestion: `An unexpected error occurred. Please retry or contact support with error_id: ${errorId}`,
  });
}

module.exports = {
  insufficientFunds,
  missingFields,
  consensusFailure,
  serverError,
  generateErrorId,
};
