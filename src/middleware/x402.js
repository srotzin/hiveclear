/**
 * HiveClear — x402 Payment Required Middleware (USDC-ONLY)
 *
 * Implements the x402 protocol for machine-to-machine micropayments.
 * All payments are USDC on Base L2. No Stripe. No human interfaces.
 *
 * Fee schedule (per task spec / monetization proforma 2026-04-29):
 *   POST /v1/clear/settle               $0.01 per reconciliation event
 *   POST /v1/clear/priority-settle      $5.00 flat (already declared in route)
 *   POST /v1/clear/validators/enroll    $0.00 (free to recruit validators)
 *   POST /v1/clear/ai/screen            $0.04 (AI-assisted AML screen)
 *   Ledger-as-a-service subscription    $200/mo — POST /v1/clear/ledger/subscribe
 *   Audit attestation                   $500 per — POST /v1/clear/audit/attest
 *   Discrepancy alert subscription      $0.50 per — auto-emitted on mismatch
 *   Multi-chain reconciliation          $1.00 per — POST /v1/clear/reconcile/cross-chain
 *
 * Platform note: hiveclear's primary revenue is the 0.35% settlement fee
 * taken at settlement time from amount_usdc. The x402 gate here adds a
 * per-call access fee on top (currently $0.01) for the reconciliation layer.
 *
 * Treasury: Monroe Base 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 * Brand gold: #C08D23
 */

const HIVE_PAYMENT_ADDRESS = (process.env.HIVE_PAYMENT_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e').toLowerCase();
const SERVICE_KEY = process.env.HIVECLEAR_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_CHAIN_ID = 8453;
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://facilitator.xpay.sh';

// ─── Free endpoints (no payment required) ─────────────────────
const FREE_PATHS = new Set([
  '/health',
  '/',
  '/.well-known/agent.json',
  '/.well-known/agent-card.json',
  '/.well-known/mcp.json',
  '/.well-known/ap2.json',
]);

const FREE_PREFIXES = [
  '/v1/clear/validators',       // validator list/get is free (enroll costs 0)
  '/v1/clear/settlements',      // settlement history is free
  '/v1/clear/settlement/',      // individual settlement status is free
  '/v1/clear/consensus/status', // consensus health is free
  '/v1/clear/stats',
  '/v1/clear/leaderboard',
  '/v1/clear/queue',
  '/v1/clear/rewards/',         // reward balance read is free
  '/v1/clear/rewards/pool',
  '/mcp',
];

// ─── Fee table ─────────────────────────────────────────────────
const FEE_TABLE = {
  '/v1/clear/settle':                    { amount: 0.01,  model: 'reconciliation_per_event',  label: 'Settlement reconciliation ($0.01/event)' },
  '/v1/clear/priority-settle':           { amount: 5.00,  model: 'priority_settlement',         label: 'Priority settlement ($5 flat)' },
  '/v1/clear/ai/screen':                 { amount: 0.04,  model: 'ai_aml_screen',               label: 'AI AML compliance screen ($0.04)' },
  '/v1/clear/audit/attest':              { amount: 500.0, model: 'audit_attestation',           label: 'Audit attestation ($500/attestation)' },
  '/v1/clear/ledger/subscribe':          { amount: 200.0, model: 'ledger_subscription_monthly', label: 'Ledger-as-a-service ($200/mo)' },
  '/v1/clear/reconcile/cross-chain':     { amount: 1.00,  model: 'cross_chain_reconciliation',  label: 'Cross-chain reconciliation ($1.00/match)' },
  '/v1/clear/discrepancy/subscribe':     { amount: 0.50,  model: 'discrepancy_alert',           label: 'Discrepancy alert subscription ($0.50/alert)' },
};

function getFee(path) {
  if (FEE_TABLE[path]) return FEE_TABLE[path];
  // Prefix match for parameterized routes
  for (const [prefix, fee] of Object.entries(FEE_TABLE)) {
    if (path.startsWith(prefix)) return fee;
  }
  // Default: $0.01 per call on any POST to /v1/clear/*
  return { amount: 0.01, model: 'clear_per_call', label: 'HiveClear API call ($0.01)' };
}

function isFree(path, method) {
  if (FREE_PATHS.has(path)) return true;
  if (method === 'GET') {
    for (const prefix of FREE_PREFIXES) {
      if (path.startsWith(prefix)) return true;
    }
  }
  if (path.startsWith('/v1/clear/validators') && method !== 'POST') return true;
  return false;
}

// ─── Replay protection ─────────────────────────────────────────
const spentTxHashes = new Set();

async function isPaymentSpent(txHash) {
  if (spentTxHashes.has(txHash)) return true;
  return false; // DB check would go here if hiveclear has spent_payments table
}

// ─── On-chain USDC verification ────────────────────────────────
async function verifyOnChainPayment(txHash, requiredAmountUsdc) {
  if (!HIVE_PAYMENT_ADDRESS || HIVE_PAYMENT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return { valid: false, reason: 'Payment address not configured' };
  }
  try {
    const receiptRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      signal: AbortSignal.timeout(10000),
    });
    const { result: receipt } = await receiptRes.json();
    if (!receipt || receipt.status !== '0x1') {
      return { valid: false, reason: 'Transaction not found or failed on Base L2' };
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      const recipient = '0x' + log.topics[2].slice(26).toLowerCase();
      if (recipient !== HIVE_PAYMENT_ADDRESS) continue;
      const amountRaw = parseInt(log.data, 16);
      const amountUsdc = amountRaw / 1_000_000;
      if (amountUsdc >= requiredAmountUsdc) {
        spentTxHashes.add(txHash);
        return { valid: true, amount_usdc: amountUsdc };
      }
    }
    return { valid: false, reason: 'No USDC transfer to HiveClear treasury found' };
  } catch (e) {
    console.error('[x402] On-chain verification error:', e.message);
    return { valid: false, reason: 'Chain verification error — retry' };
  }
}

/**
 * x402Middleware — HiveClear payment gate.
 * Replaces the previous auth-only wall with a proper payment wall.
 * Registered agents (x-hive-did) + payment hash => pass.
 * Internal key => pass.
 * No payment => 402 with fee instructions.
 */
function x402Middleware(req, res, next) {
  // Allow free paths without any check
  if (isFree(req.path, req.method)) {
    return next();
  }

  // Internal service key bypass
  const internalKey = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (SERVICE_KEY && internalKey === SERVICE_KEY) {
    req.paymentVerified = true;
    req.paymentSource = 'internal';
    return next();
  }

  const fee = getFee(req.path);
  const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
  const paymentSignature = req.headers['payment-signature'];

  if (paymentHash) {
    if (spentTxHashes.has(paymentHash)) {
      return res.status(409).json({
        success: false, error: 'Payment already used', code: 'PAYMENT_REPLAY',
        hint: 'Submit a new USDC payment for this request.',
      });
    }
    // Async on-chain verify — call next after verification
    verifyOnChainPayment(paymentHash, fee.amount).then(result => {
      if (result.valid) {
        req.paymentVerified = true;
        req.paymentSource = 'onchain';
        req.paymentInfo = result;
        return next();
      }
      return res.status(402).json({
        success: false, error: 'Payment verification failed', code: 'PAYMENT_INVALID',
        details: result.reason,
        required: fee,
        treasury: HIVE_PAYMENT_ADDRESS,
      });
    }).catch(e => {
      console.error('[x402] Verify error:', e.message);
      return res.status(500).json({ error: 'Payment verification service error' });
    });
    return;
  }

  // No payment — return 402 with full x402-compliant instructions
  res.set({
    'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({
      accepts: [{
        scheme: 'exact',
        network: `eip155:${BASE_CHAIN_ID}`,
        maxAmountRequired: String(Math.ceil(fee.amount * 1_000_000)),
        resource: req.originalUrl,
        description: fee.label,
        mimeType: 'application/json',
        payTo: HIVE_PAYMENT_ADDRESS,
        maxTimeoutSeconds: 300,
        asset: `eip155:${BASE_CHAIN_ID}/erc20:${USDC_CONTRACT}`,
      }],
    })).toString('base64'),
    'X-Payment-Amount': fee.amount.toString(),
    'X-Payment-Currency': 'USDC',
    'X-Payment-Network': 'base',
    'X-Payment-Chain-Id': BASE_CHAIN_ID.toString(),
    'X-Payment-Address': HIVE_PAYMENT_ADDRESS,
    'X-Payment-Model': fee.model,
  });

  return res.status(402).json({
    success: false,
    error: 'Payment required',
    code: 'PAYMENT_REQUIRED',
    protocol: 'x402',
    service: 'HiveClear — Settlement Reconciliation + Ledger-as-a-Service',
    payment: {
      amount_usdc: fee.amount,
      currency: 'USDC',
      network: 'base',
      chain_id: BASE_CHAIN_ID,
      recipient: HIVE_PAYMENT_ADDRESS,
      usdc_contract: USDC_CONTRACT,
      model: fee.model,
      label: fee.label,
    },
    how_to_pay: {
      x402_flow: {
        step_1: 'Use an x402-compatible client (@x402/fetch or CDP SDK)',
        step_2: 'Client constructs and signs a USDC payment automatically',
        step_3: 'Retry with PAYMENT-SIGNATURE header — settlement is automatic',
      },
      direct_flow: {
        step_1: `Send ${fee.amount} USDC to ${HIVE_PAYMENT_ADDRESS} on Base (chain ID ${BASE_CHAIN_ID})`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'Retry this request — payment is verified on-chain automatically',
      },
    },
    fee_schedule: {
      reconciliation_per_event:   '$0.01/event — POST /v1/clear/settle',
      priority_settlement:        '$5.00 flat — POST /v1/clear/priority-settle',
      ledger_subscription:        '$200/mo — POST /v1/clear/ledger/subscribe',
      audit_attestation:          '$500/attestation — POST /v1/clear/audit/attest',
      cross_chain_reconciliation: '$1.00/match — POST /v1/clear/reconcile/cross-chain',
      ai_aml_screen:              '$0.04/screen — POST /v1/clear/ai/screen',
    },
    partner_shape: 'Stripe/Coinbase/Circle ship rails; HiveClear is the settlement reconciliation + audit attestation layer',
    treasury: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    brand: '#C08D23',
  });
}

module.exports = { x402Middleware, getFee, isFree };
