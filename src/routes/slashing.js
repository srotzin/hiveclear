const express = require('express');
const router = express.Router();
const { slashValidator, getSlashingHistory } = require('../services/slashing');

// POST /v1/clear/slash
router.post('/slash', async (req, res) => {
  try {
    const { validator_did, reason, evidence } = req.body;

    if (!validator_did || !reason) {
      return res.status(400).json({ error: 'validator_did and reason are required' });
    }

    const result = await slashValidator({ validator_did, reason, evidence });
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[slashing/slash] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/slashing/history
router.get('/slashing/history', (req, res) => {
  try {
    const events = getSlashingHistory();
    res.json({ events, total: events.length });
  } catch (err) {
    console.error('[slashing/history] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
