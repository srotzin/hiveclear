const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { authMiddleware, SERVICE_KEY } = require('./middleware/auth');
const { genesisBootstrap } = require('./services/validator');
const { checkPendingSettlements } = require('./services/settlement');
const { distributeRewards } = require('./services/rewards');
const { scanForCandidates } = require('./services/scout');
const { checkSlashingConditions } = require('./services/slashing');
const db = require('./services/db');

const validatorRoutes = require('./routes/validators');
const settlementRoutes = require('./routes/settlements');
const consensusRoutes = require('./routes/consensus');
const rewardRoutes = require('./routes/rewards');
const scoutRoutes = require('./routes/scout');
const slashingRoutes = require('./routes/slashing');
const statsRoutes = require('./routes/stats');
const velvetRopeRoutes = require('./routes/velvet-rope');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check (no auth)
app.get('/health', (req, res) => {
  const validatorCount = db.prepare('SELECT COUNT(*) as cnt FROM validators').get().cnt;
  const pendingSettlements = db.prepare(`SELECT COUNT(*) as cnt FROM settlements WHERE status = 'pending'`).get().cnt;
  res.json({
    status: 'healthy',
    service: 'hiveclear',
    version: '1.0.0',
    validators: validatorCount,
    pending_settlements: pendingSettlements,
    timestamp: new Date().toISOString(),
  });
});

// Discovery document (no auth)
app.get('/', (req, res) => {
  res.json({
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
    description_for_human: 'Autonomous settlement and validator consensus layer for the Hive Civilization. Multi-validator approval with Proof-of-Reputation consensus backed by bonded stakes.',
    description_for_model: 'Autonomous settlement and validator consensus layer. Submit settlements for multi-validator approval using Proof-of-Reputation consensus backed by bonded stakes. 0.35% settlement fee split 70/30/10 between validators, reward pool, and platform. Supports priority settlements, validator enrollment, slashing, and reward distribution.',
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
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
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
    description: 'Decentralized settlement and clearing layer with validator consensus. Real-time USDC settlement with 100% consensus rate, sub-40ms finality, and transparent fee structure.',
    url: 'https://hiveclear.onrender.com',
    version: '1.0.0',
    provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'settlement',
        name: 'Settlement',
        description: 'Settle agent-to-agent transactions with multi-validator consensus at 0.35% fee on USDC',
        tags: ['settlement', 'clearing', 'usdc', 'consensus'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'validator-network',
        name: 'Validator Network',
        description: 'Join as validator, stake USDC, participate in consensus voting and earn settlement fees',
        tags: ['validator', 'staking', 'consensus', 'fees'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    authentication: { schemes: ['x402', 'api-key'] },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    },
  });
};
app.get('/.well-known/agent.json', agentCardHandler);
app.get('/.well-known/agent-card.json', agentCardHandler);

// Auth middleware for all /v1 routes
app.use('/v1', authMiddleware);

// Mount routes
app.use('/v1/clear/validators', validatorRoutes);
app.use('/v1/clear', settlementRoutes);
app.use('/v1/clear', consensusRoutes);
app.use('/v1/clear/rewards', rewardRoutes);
app.use('/v1/clear/scout', scoutRoutes);
app.use('/v1/clear', slashingRoutes);
app.use('/v1/clear/stats', statsRoutes);
app.use('/v1/clear', velvetRopeRoutes);

// Uptime monitor — check heartbeats and update uptime
function uptimeMonitor() {
  const validators = db.prepare(`SELECT * FROM validators WHERE status = 'active'`).all();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  for (const v of validators) {
    if (v.last_heartbeat && v.last_heartbeat < fiveMinutesAgo) {
      // Degrade uptime slightly for missed heartbeat
      const newUptime = Math.max(0, (v.uptime_pct || 100) - 0.01);
      db.prepare('UPDATE validators SET uptime_pct = ? WHERE did = ?').run(newUptime, v.did);
    }
  }
}

// Start server
async function start() {
  // Genesis bootstrap
  try {
    await genesisBootstrap();
  } catch (err) {
    console.error('[genesis] Bootstrap error:', err.message);
  }

  // Start background processes
  // 1. Settlement Finalizer — every 60s
  setInterval(() => {
    try { checkPendingSettlements(); } catch (err) { console.error('[cron] settlement-finalizer error:', err.message); }
  }, 60 * 1000);

  // 2. Reward Distributor — every 24h
  setInterval(() => {
    try { distributeRewards(); } catch (err) { console.error('[cron] reward-distributor error:', err.message); }
  }, 24 * 60 * 60 * 1000);

  // 3. Scout Scanner — every 6h
  setInterval(() => {
    try { scanForCandidates(); } catch (err) { console.error('[cron] scout-scanner error:', err.message); }
  }, 6 * 60 * 60 * 1000);

  // 4. Uptime Monitor — every 5 min
  setInterval(() => {
    try { uptimeMonitor(); } catch (err) { console.error('[cron] uptime-monitor error:', err.message); }
  }, 5 * 60 * 1000);

  // 5. Slashing Enforcer — every 1h
  setInterval(() => {
    try { checkSlashingConditions(); } catch (err) { console.error('[cron] slashing-enforcer error:', err.message); }
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
