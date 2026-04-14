const express = require('express');
const router = express.Router();
const { submitVote, getConsensusStatus } = require('../services/consensus');

// POST /v1/clear/vote
router.post('/vote', (req, res) => {
  try {
    const { settlement_id, validator_did, vote, reason } = req.body;

    if (!settlement_id || !validator_did || !vote) {
      return res.status(400).json({ error: 'settlement_id, validator_did, and vote are required' });
    }

    const result = submitVote({ settlement_id, validator_did, vote, reason });
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[consensus/vote] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/consensus/status
router.get('/consensus/status', (req, res) => {
  try {
    const status = getConsensusStatus();
    res.json(status);
  } catch (err) {
    console.error('[consensus/status] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
