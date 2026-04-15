const { v4: uuidv4 } = require('uuid');
const db = require('./services/db');
const { createSettlement, getSettlement } = require('./services/settlement');

const TOOL_DEFINITIONS = [
  {
    name: 'hiveclear_submit_settlement',
    description:
      'Submit a settlement for multi-party validator consensus. Each party is identified by a DID with a role and USDC amount. The settlement enters a pending state and is finalized once validators reach 67% approval threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        parties: {
          type: 'array',
          description: 'The parties involved in the settlement',
          items: {
            type: 'object',
            properties: {
              did: { type: 'string', description: 'Decentralized identifier of the party' },
              role: { type: 'string', description: 'Role in the settlement (e.g. sender, receiver)' },
              amount_usdc: { type: 'number', description: 'USDC amount for this party' },
            },
            required: ['did', 'role', 'amount_usdc'],
          },
        },
        settlement_type: {
          type: 'string',
          description: 'Type of settlement (e.g. payment, escrow, refund)',
        },
        memo: {
          type: 'string',
          description: 'Human-readable memo or description for the settlement',
        },
      },
      required: ['parties', 'settlement_type'],
    },
  },
  {
    name: 'hiveclear_get_status',
    description:
      'Get the current status of a settlement by its ID, including vote breakdown from validators.',
    inputSchema: {
      type: 'object',
      properties: {
        settlement_id: {
          type: 'string',
          description: 'The settlement ID (e.g. stl_abc123)',
        },
      },
      required: ['settlement_id'],
    },
  },
  {
    name: 'hiveclear_get_stats',
    description:
      'Get clearing network statistics: settlement volume today, fees collected today, consensus approval rate, and total settlement count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hiveclear_list_validators',
    description:
      'List all active validators in the consensus network with their voting power, bond amount, uptime, and earnings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

async function executeSubmitSettlement(params) {
  const { parties, settlement_type, memo } = params;

  if (!parties || !Array.isArray(parties) || parties.length < 2) {
    return { error: 'At least two parties are required' };
  }

  const sender = parties.find((p) => p.role === 'sender') || parties[0];
  const receiver = parties.find((p) => p.role === 'receiver') || parties[1];
  const amount = receiver.amount_usdc || sender.amount_usdc;

  if (!amount || amount <= 0) {
    return { error: 'A positive amount_usdc is required' };
  }

  const result = await createSettlement({
    transaction_id: `txn_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
    from_did: sender.did,
    to_did: receiver.did,
    amount_usdc: amount,
    service: settlement_type,
    memo: memo || null,
  });

  return {
    settlement_id: result.settlement_id,
    status: result.status,
    amount_usdc: result.amount_usdc,
    fee_usdc: result.fee_usdc,
    from: sender.did,
    to: receiver.did,
    created_at: result.created_at,
  };
}

async function executeGetStatus(params) {
  const { settlement_id } = params;
  if (!settlement_id) {
    return { error: 'settlement_id is required' };
  }

  const settlement = await getSettlement(settlement_id);
  if (!settlement) {
    return { error: 'Settlement not found' };
  }

  return {
    settlement_id: settlement.settlement_id,
    status: settlement.status,
    amount_usdc: parseFloat(settlement.amount_usdc),
    fee_usdc: parseFloat(settlement.fee_usdc),
    from: settlement.from_did,
    to: settlement.to_did,
    votes: {
      for: parseFloat(settlement.votes_for),
      against: parseFloat(settlement.votes_against),
      abstain: parseFloat(settlement.votes_abstain),
    },
    total_voting_power: parseFloat(settlement.total_voting_power),
    threshold_met: !!settlement.threshold_met,
    created_at: settlement.created_at,
    settled_at: settlement.settled_at,
    vote_breakdown: settlement.vote_breakdown || [],
  };
}

async function executeGetStats() {
  const today = new Date().toISOString().split('T')[0];

  const volumeTodayRow = await db.getOne(
    `SELECT SUM(amount_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= $1`,
    [today]
  );
  const volumeToday = parseFloat(volumeTodayRow?.total) || 0;

  const feesTodayRow = await db.getOne(
    `SELECT SUM(fee_usdc) as total FROM settlements WHERE status = 'approved' AND settled_at >= $1`,
    [today]
  );
  const feesToday = parseFloat(feesTodayRow?.total) || 0;

  const totalResolvedRow = await db.getOne(
    `SELECT COUNT(*) as cnt FROM settlements WHERE status IN ('approved', 'rejected')`
  );
  const totalResolved = parseInt(totalResolvedRow.cnt, 10);

  const totalApprovedRow = await db.getOne(
    `SELECT COUNT(*) as cnt FROM settlements WHERE status = 'approved'`
  );
  const totalApproved = parseInt(totalApprovedRow.cnt, 10);

  const consensusRate =
    totalResolved > 0 ? Math.round((totalApproved / totalResolved) * 10000) / 10000 : 1;

  const totalSettlementsRow = await db.getOne('SELECT COUNT(*) as cnt FROM settlements');
  const totalSettlements = parseInt(totalSettlementsRow.cnt, 10);

  return {
    volume_today_usdc: Math.round(volumeToday * 100) / 100,
    fees_today_usdc: Math.round(feesToday * 100) / 100,
    consensus_rate: consensusRate,
    total_settlements: totalSettlements,
  };
}

async function executeListValidators() {
  const validators = await db.getAll(
    `SELECT * FROM validators WHERE status = 'active' ORDER BY voting_power DESC`
  );

  return {
    validators: validators.map((v) => ({
      did: v.did,
      voting_power: parseFloat(v.voting_power),
      bond_amount_usdc: parseFloat(v.bond_amount_usdc),
      uptime_pct: parseFloat(v.uptime_pct),
      blocks_validated: v.blocks_validated,
      total_earned_usdc: parseFloat(v.total_earned_usdc),
      enrolled_at: v.enrolled_at,
    })),
    total: validators.length,
  };
}

const TOOL_HANDLERS = {
  hiveclear_submit_settlement: executeSubmitSettlement,
  hiveclear_get_status: executeGetStatus,
  hiveclear_get_stats: executeGetStats,
  hiveclear_list_validators: executeListValidators,
};

function handleMcpRequest(req, res) {
  const { jsonrpc, method, id, params } = req.body;

  if (jsonrpc !== '2.0' || !method || id === undefined) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
    });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'hiveclear',
          version: '1.0.0',
        },
      },
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOL_DEFINITIONS },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${toolName}` },
      });
    }

    handler(toolArgs)
      .then((result) => {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        });
      })
      .catch((err) => {
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err.message },
        });
      });
    return;
  }

  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

module.exports = { handleMcpRequest, TOOL_DEFINITIONS };
