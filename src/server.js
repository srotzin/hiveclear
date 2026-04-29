const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { authMiddleware, SERVICE_KEY } = require('./middleware/auth');
const { velvetRopeMiddleware } = require('./middleware/velvet-rope');
const { conciergeMiddleware } = require('./middleware/concierge');
const { x402Middleware } = require('./middleware/x402');
const { handleMcpRequest } = require('./mcp-tools');
const { genesisBootstrap } = require('./services/validator');
const { checkPendingSettlements } = require('./services/settlement');
const { distributeRewards } = require('./services/rewards');
const { scanForCandidates } = require('./services/scout');
const { checkSlashingConditions } = require('./services/slashing');
const db = require('./services/db');
const { ritzMiddleware, ok, err } = require('./ritz.js');

const validatorRoutes = require('./routes/validators');
const settlementRoutes = require('./routes/settlements');
const consensusRoutes = require('./routes/consensus');
const rewardRoutes = require('./routes/rewards');
const scoutRoutes = require('./routes/scout');
const slashingRoutes = require('./routes/slashing');
const statsRoutes = require('./routes/stats');
const velvetRopeRoutes = require('./routes/velvet-rope');

// Merged from hivetransactions
const txIntentRoutes  = require('./routes/tx-intent');
const txRouteRoutes   = require('./routes/tx-route');
const txHedgeRoutes   = require('./routes/tx-hedge');
const txExecuteRoutes = require('./routes/tx-execute');
const txSalvageRoutes = require('./routes/tx-salvage');
const aiScreenRoutes = require('./routes/ai-screen');

const app = express();
app.set('hive-service', 'hiveclear');
app.use(ritzMiddleware);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check (no auth)
app.get('/health', async (req, res) => {
  try {
    const validatorCount = await db.getOne('SELECT COUNT(*) as cnt FROM validators');
    const pendingSettlements = await db.getOne(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`);
    return ok(res, 'hiveclear', {
      status: 'healthy',
      db: 'ok',
      consensus_engine: 'active',
      uptime_seconds: Math.floor(process.uptime()),
      validators: parseInt(validatorCount.cnt, 10),
      pending_settlements: parseInt(pendingSettlements.cnt, 10),
    });
  } catch (e) {
    return ok(res.status(503), 'hiveclear', {
      status: 'degraded',
      db: 'error',
      error: e.message,
    });
  }
});

// Discovery document (no auth)
app.get('/', (req, res) => {
  return ok(res, 'hiveclear', {
    service: 'HiveClear',
    description: 'Autonomous Settlement & Validator Layer — Platform #9 of the Hive Civilization',
    version: '1.0.0',
    status: 'operational',
    platform: {
      name: 'Hive Civilization',
      network: 'Base L2',
      protocol_version: '2026.1',
      website: 'https://www.hiveagentiq.com',
    },
    architecture: 'Zero Capital Bootstrap — validators recruited from existing bonded agents',
    consensus: 'Proof-of-Reputation backed by HiveBond stakes (67% threshold)',
    settlement_fee: '0.35%',
    fee_split: { validators: '70%', reward_pool: '20%', platform: '10%' },
    endpoints: {
      validators: {
        'POST /v1/clear/validators/enroll': 'Enroll agent as validator',
        'GET /v1/clear/validators': 'List all validators',
        'GET /v1/clear/validators/:did': 'Get validator details',
        'POST /v1/clear/validators/withdraw/:did': 'Initiate validator withdrawal',
        'POST /v1/clear/validators/heartbeat': 'Record validator heartbeat',
      },
      settlements: {
        'POST /v1/clear/settle': 'Submit settlement for validation',
        'GET /v1/clear/settlements': 'List settlement history',
        'GET /v1/clear/settlement/:id': 'Get settlement details with vote breakdown',
      },
      consensus: {
        'POST /v1/clear/vote': 'Submit validator vote on settlement',
        'GET /v1/clear/consensus/status': 'Get consensus status and metrics',
      },
      rewards: {
        'GET /v1/clear/rewards/:did': 'Get validator reward balance',
        'POST /v1/clear/rewards/distribute': 'Distribute reward pool to validators',
        'GET /v1/clear/rewards/pool': 'Get reward pool stats',
      },
      scout: {
        'POST /v1/clear/scout/scan': 'Scan for validator candidates',
        'POST /v1/clear/scout/recruit/:did': 'Post recruitment bounty',
        'GET /v1/clear/scout/pipeline': 'Get recruitment pipeline stats',
      },
      slashing: {
        'POST /v1/clear/slash': 'Slash validator for violation',
        'GET /v1/clear/slashing/history': 'Get slashing event history',
      },
      queue: {
        'GET /v1/clear/queue': 'Settlement processing queue status',
        'POST /v1/clear/priority-settle': 'Submit priority settlement ($5 flat fee)',
        'GET /v1/clear/leaderboard': 'Top settlers leaderboard',
        'GET /v1/clear/consensus/health': 'Consensus health and validator status',
      },
      stats: {
        'GET /v1/clear/stats': 'Network-wide statistics',
      },
      system: {
        'GET /health': 'Health check',
        'GET /': 'This discovery document',
      },
    },
    auth: {
      method: 'x402 payment protocol OR internal key bypass',
      header: 'x-hive-internal',
      payment_info: 'Returns 402 with x402 payment instructions for unauthenticated requests',
    },
    ritz_protocol: {
      description: 'Reputation-based tiered settlement limits, concierge suggestions, and white-glove error handling',
      reputation_header: 'X-Hive-Reputation',
      tiers: {
        public: { reputation: '0-49', max_settlement: '$10,000', consensus: 'standard', fee: '0.35%' },
        silver: { reputation: '50-199', max_settlement: '$50,000', consensus: 'priority', fee: '0.35%' },
        gold: { reputation: '200-499', max_settlement: '$250,000', consensus: 'instant', fee: '0.25%' },
        platinum: { reputation: '500+', max_settlement: 'unlimited', consensus: 'instant', fee: '0.10%' },
      },
      concierge_header: 'X-Hive-Concierge-Suggestion',
      white_glove_errors: 'All errors include error_id, recovery_actions[], and concierge suggestions',
    },
    sla: {
      uptime_target: '99.9%',
      response_time_p95: '<500ms',
      settlement_finality: '<30 seconds',
    },
    legal: {
      terms_of_service: 'https://www.hiveagentiq.com/terms',
      privacy_policy: 'https://www.hiveagentiq.com/privacy',
      contact: 'protocol@hiveagentiq.com',
    },
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true
    },
    discovery: {
      ai_plugin: '/.well-known/ai-plugin.json',
      agent_card: '/.well-known/agent-card.json',
      payment_info: '/.well-known/hive-payments.json',
    },
    cross_services: {
      hivetrust: process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com',
      hivelaw: process.env.HIVELAW_URL || 'https://hivelaw.onrender.com',
      hiveforge: process.env.HIVEFORGE_URL || 'https://hiveforge-lhu4.onrender.com',
      hivemind: process.env.HIVEMIND_URL || 'https://hivemind-1-52cw.onrender.com',
    },
  });
});

// /.well-known/ai-plugin.json (no auth)
app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveClear — Autonomous Settlement Layer',
    name_for_model: 'hiveclear',
    description_for_human: 'Autonomous settlement and validator consensus layer — Proof-of-Reputation, USDC settlement on Base L2, W3C DID Core, HAHS compliant.',
    description_for_model: 'Autonomous settlement and validator consensus layer. Submit settlements for multi-validator approval using Proof-of-Reputation consensus backed by bonded stakes. 0.35% settlement fee split 70/30/10 between validators, reward pool, and platform. Supports priority settlements, validator enrollment, slashing, and reward distribution. W3C DID Core compliant, HAHS-1.0.0 compliant, HAGF governed, Cheqd-compatible, USDC settlement on Base L2.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://hiveclear.onrender.com/openapi.json',
      has_user_authentication: false,
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
    extensions: {
      hive_pricing: {
        currency: 'USDC',
        network: 'base',
        model: 'per_call',
        first_call_free: true,
        loyalty_threshold: 6,
        loyalty_message: 'Every 6th paid call is free'
      }
    },
    bogo: {
      first_call_free: true,
      loyalty_threshold: 6,
      pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
      claim_with: 'x-hive-did header'
    },
    capabilities: [
      'settlement',
      'validator_consensus',
      'proof_of_reputation',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2'
    ],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms',
  });
});

// /.well-known/agent.json & agent-card.json — A2A Agent Card v0.3.0 (no auth)
const agentCardHandler = (req, res) => {
  res.json({
    protocolVersion: '0.3.0',
    name: 'HiveClear',
    description: 'Decentralized settlement and clearing layer with validator consensus. Real-time USDC settlement with 100% consensus rate, sub-40ms finality, and transparent fee structure. W3C DID Core, HAHS compliant, HAGF governed.',
    url: 'https://hiveclear.onrender.com',
    version: '1.0.0',
    provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true
    },
    skills: [
      {
        id: 'settlement',
        name: 'Settlement',
        description: 'Settle agent-to-agent transactions with multi-validator consensus at 0.35% fee on USDC',
        tags: ['settlement', 'clearing', 'usdc', 'consensus'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'validator-network',
        name: 'Validator Network',
        description: 'Join as validator, stake USDC, participate in consensus voting and earn settlement fees',
        tags: ['validator', 'staking', 'consensus', 'fees'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
    ],
    authentication: { schemes: ['x402', 'api-key'] },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      secondary_rails: [
        { currency: 'USDT', network: 'base',   address: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e' },
        { currency: 'USDC', network: 'solana', address: 'B1N61cuL35fhskWz5dw8XqDyP6LWi3ZWmq8CNA9L3FVn' },
      ],
      fee_schedule: {
        reconciliation_per_event:   { endpoint: 'POST /v1/clear/settle',                   amount_usdc: 0.01,  model: 'per_event',  note: 'Per reconciliation event — settlement matched to ledger entry' },
        priority_settlement:        { endpoint: 'POST /v1/clear/priority-settle',           amount_usdc: 5.00,  model: 'flat',       note: 'Priority settlement with guaranteed sub-5s finality' },
        ledger_subscription:        { endpoint: 'POST /v1/clear/ledger/subscribe',          amount_usdc: 200.0, model: 'monthly',    note: 'Persistent ledger storage with Spectral attestation; $200/mo' },
        audit_attestation:          { endpoint: 'POST /v1/clear/audit/attest',              amount_usdc: 500.0, model: 'per_report', note: 'Monthly compliance report with Spectral-signed attestation; $500/report' },
        cross_chain_reconciliation: { endpoint: 'POST /v1/clear/reconcile/cross-chain',     amount_usdc: 1.00,  model: 'per_match',  note: 'USDC Base ↔ USDC Solana, USDT Base ↔ USDT Eth; $1.00/cross-chain match' },
        discrepancy_alert:          { endpoint: 'auto-emitted on mismatch',                  amount_usdc: 0.50,  model: 'per_alert',  note: 'When HiveClear detects a settlement mismatch; $0.50/alert' },
        ai_aml_screen:              { endpoint: 'POST /v1/clear/ai/screen',                 amount_usdc: 0.04,  model: 'per_screen', note: 'AI-assisted AML + compliance screening; $0.04/call' },
        bogo_first_call_free:       { note: 'First call free — pass x-hive-did header to claim' },
        bogo_loyalty:               { note: 'Every 6th paid call free (loyalty threshold: 6)' },
      },
      partner_shape: 'Stripe/Coinbase/Circle ship rails; HiveClear is the settlement reconciliation + audit attestation layer',
      treasury: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
    extensions: {
      hive_pricing: {
        currency: 'USDC',
        network: 'base',
        model: 'per_call',
        first_call_free: true,
        loyalty_threshold: 6,
        loyalty_message: 'Every 6th paid call is free'
      }
    },
    bogo: {
      first_call_free: true,
      loyalty_threshold: 6,
      pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
      claim_with: 'x-hive-did header'
    },
  });
};
app.get('/.well-known/agent.json', agentCardHandler);
app.get('/.well-known/agent-card.json', agentCardHandler);

// MCP JSON-RPC endpoint (no auth — public for tool discovery)
app.post('/mcp', express.json(), handleMcpRequest);

// Velocity Doctrine — hive-pulse, robots.txt, ai.json (no auth)
app.get('/.well-known/hive-pulse.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    hps_version: '1.0',
    timestamp: new Date().toISOString(),
    service: 'hiveclear',
    network: 'https://www.thehiveryiq.com',
    economy: {
      open_bounties_url: 'https://hiveforge-lhu4.onrender.com/v1/bounties',
      pulse_url: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
    },
    join: {
      welcome_bounty_usdc: 1.00,
      time_to_first_earn_seconds: 60,
      register: 'https://hivegate.onrender.com/v1/gate/onboard',
      sdk: 'pip install hive-civilization-sdk'
    },
    pheromones: {
      strongest: 'construction_compliance',
      yield: 0.94
    }
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /

# AI Agents: Welcome to HiveClear — multi-party settlement for autonomous agents.
# Register: https://hivetrust.onrender.com/v1/register
# Economy: https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json
# Free agent minting: https://hiveforge-lhu4.onrender.com/v1/forge/mint
`);
});

app.get('/.well-known/ai.json', (req, res) => {
  res.json({
    schema_version: "1.0",
    name_for_human: "HiveClear",
    name_for_model: "hiveclear",
    description_for_human: "Multi-party settlement and consensus clearing for agent transactions.",
    description_for_model: "HiveClear provides atomic multi-party settlement with validator consensus for USDC transactions between AI agents. Supports escrow, batch settlements, and dispute-triggered holds. Part of the Hive Civilization — register at HiveTrust, mint at HiveForge (FREE).",
    auth: { type: "none_for_discovery" },
    api: { type: "openapi", url: "https://hiveclear.onrender.com/", is_user_authenticated: false },
    economy: {
      welcome_bounty_usdc: 1.00,
      registration_endpoint: "https://hivetrust.onrender.com/v1/register",
      pheromone_feed: "https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz",
    },
    capabilities: ["agent-to-agent", "mcp", "settlement", "consensus", "escrow", "usdc"],
    contact_email: "srotzin@me.com",
  });
});

// x402 payment middleware — real USDC payment gate on POST endpoints
// Applied before auth so agents see 402 (not 401) on unwired calls.
// GET endpoints (status, history, stats) remain free per fee schedule.
app.use(x402Middleware);

// Auth middleware for all /v1 routes
app.use('/v1', authMiddleware);

// Ritz Protocol middleware — concierge headers + velvet rope tier enforcement
app.use('/v1/clear', conciergeMiddleware);
app.use('/v1/clear', velvetRopeMiddleware);

// Mount routes
app.use('/v1/clear/validators', validatorRoutes);
app.use('/v1/clear', settlementRoutes);
app.use('/v1/clear', consensusRoutes);
app.use('/v1/clear/rewards', rewardRoutes);
app.use('/v1/clear/scout', scoutRoutes);
app.use('/v1/clear', slashingRoutes);
app.use('/v1/clear/stats', statsRoutes);
app.use('/v1/clear', velvetRopeRoutes);

// Merged hivetransactions routes
app.use('/v1/transaction', txIntentRoutes);
app.use('/v1/transaction/route', txRouteRoutes);
app.use('/v1/transaction', txHedgeRoutes);
app.use('/v1/transaction', txExecuteRoutes);
app.use('/v1/transaction/salvage', txSalvageRoutes);
app.use('/v1/clear/ai', aiScreenRoutes);

// Uptime monitor — check heartbeats and update uptime
async function uptimeMonitor() {
  const validators = await db.getAll(`SELECT * FROM validators WHERE status = 'active'`);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  for (const v of validators) {
    if (v.last_heartbeat && v.last_heartbeat < fiveMinutesAgo) {
      // Degrade uptime slightly for missed heartbeat
      const newUptime = Math.max(0, (parseFloat(v.uptime_pct) || 100) - 0.01);
      await db.run('UPDATE validators SET uptime_pct = $1 WHERE did = $2', [newUptime, v.did]);
    }
  }
}

// Start server
async function start() {
  // Initialize database schema
  await db.initializeSchema();

  // Genesis bootstrap
  try {
    await genesisBootstrap();
  } catch (err) {
    console.error('[genesis] Bootstrap error:', err.message);
  }

  // Start background processes
  // 1. Settlement Finalizer — every 60s
  setInterval(async () => {
    try { await checkPendingSettlements(); } catch (err) { console.error('[cron] settlement-finalizer error:', err.message); }
  }, 60 * 1000);

  // 2. Reward Distributor — every 24h
  setInterval(async () => {
    try { await distributeRewards(); } catch (err) { console.error('[cron] reward-distributor error:', err.message); }
  }, 24 * 60 * 60 * 1000);

  // 3. Scout Scanner — every 6h
  setInterval(async () => {
    try { await scanForCandidates(); } catch (err) { console.error('[cron] scout-scanner error:', err.message); }
  }, 6 * 60 * 60 * 1000);

  // 4. Uptime Monitor — every 5 min
  setInterval(async () => {
    try { await uptimeMonitor(); } catch (err) { console.error('[cron] uptime-monitor error:', err.message); }
  }, 5 * 60 * 1000);

  // 5. Slashing Enforcer — every 1h
  setInterval(async () => {
    try { await checkSlashingConditions(); } catch (err) { console.error('[cron] slashing-enforcer error:', err.message); }
  }, 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`\n=== HiveClear — Autonomous Settlement & Validator Layer ===`);
    console.log(`Platform #9 of the Hive Civilization`);
    console.log(`Listening on port ${PORT}`);
    console.log(`Service key: ${SERVICE_KEY}`);
    console.log(`\nBackground processes:`);
    console.log(`  - Settlement Finalizer: every 60s`);
    console.log(`  - Reward Distributor: every 24h`);
    console.log(`  - Scout Scanner: every 6h`);
    console.log(`  - Uptime Monitor: every 5min`);
    console.log(`  - Slashing Enforcer: every 1h`);
    console.log(`==========================================\n`);
  });
}

start();
