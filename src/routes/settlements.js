const express = require('express');
const router = express.Router();
const { createSettlement, getSettlements, getSettlement } = require('../services/settlement');
const whiteGlove = require('../middleware/white-glove-errors');

// POST /v1/clear/settle
router.post('/settle', async (req, res) => {
  try {
    const { transaction_id, from_did, to_did, amount_usdc, service, memo } = req.body;

    // White-glove: missing fields
    const missing = [];
    if (!from_did) missing.push('from_did');
    if (!to_did) missing.push('to_did');
    if (!amount_usdc && amount_usdc !== 0) missing.push('amount_usdc');
    if (missing.length > 0) {
      return whiteGlove.missingFields(res, { missing, endpoint: 'POST /v1/clear/settle' });
    }
    if (typeof amount_usdc !== 'number' || amount_usdc <= 0) {
      return whiteGlove.missingFields(res, {
        missing: ['amount_usdc'],
        endpoint: 'POST /v1/clear/settle',
      });
    }

    // Use tier fee rate if available (set by velvet-rope middleware)
    const tier = req.hiveTier;
    const fee_rate = tier ? tier.fee_rate : undefined;

    const result = await createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo, fee_rate });

    // Add tier info to response
    if (tier) {
      result.tier = tier.name;
      result.consensus_type = tier.consensus;
      result.fee_rate_pct = `${(tier.fee_rate * 100).toFixed(2)}%`;
    }

    res.status(201).json(result);
  } catch (err) {
    console.error('[settlements/settle] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'settle' });
  }
});

// GET /v1/clear/settlements
router.get('/settlements', async (req, res) => {
  try {
    const { status, from_did, to_did, from_date, to_date, limit, offset } = req.query;
    const settlements = await getSettlements({
      status,
      from_did,
      to_did,
      from_date,
      to_date,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ settlements, total: settlements.length });
  } catch (err) {
    console.error('[settlements/list] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'list_settlements' });
  }
});

// GET /v1/clear/settlement/:settlement_id
router.get('/settlement/:settlement_id', async (req, res) => {
  try {
    const settlement = await getSettlement(req.params.settlement_id);
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    res.json(settlement);
  } catch (err) {
    console.error('[settlements/get] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'get_settlement' });
  }
});

module.exports = router;
