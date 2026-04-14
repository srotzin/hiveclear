const express = require('express');
const router = express.Router();
const { createSettlement, getSettlements, getSettlement } = require('../services/settlement');

// POST /v1/clear/settle
router.post('/settle', (req, res) => {
  try {
    const { transaction_id, from_did, to_did, amount_usdc, service, memo } = req.body;

    if (!from_did || !to_did || !amount_usdc) {
      return res.status(400).json({ error: 'from_did, to_did, and amount_usdc are required' });
    }
    if (typeof amount_usdc !== 'number' || amount_usdc <= 0) {
      return res.status(400).json({ error: 'amount_usdc must be a positive number' });
    }

    const result = createSettlement({ transaction_id, from_did, to_did, amount_usdc, service, memo });
    res.status(201).json(result);
  } catch (err) {
    console.error('[settlements/settle] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/settlements
router.get('/settlements', (req, res) => {
  try {
    const { status, from_did, to_did, from_date, to_date, limit, offset } = req.query;
    const settlements = getSettlements({
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/settlement/:settlement_id
router.get('/settlement/:settlement_id', (req, res) => {
  try {
    const settlement = getSettlement(req.params.settlement_id);
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    res.json(settlement);
  } catch (err) {
    console.error('[settlements/get] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
