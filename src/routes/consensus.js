const express = require('express');
const router = express.Router();
const { submitVote, getConsensusStatus } = require('../services/consensus');
const whiteGlove = require('../middleware/white-glove-errors');

// POST /v1/clear/vote
router.post('/vote', (req, res) => {
  try {
    const { settlement_id, validator_did, vote, reason } = req.body;

    // White-glove: missing fields
    const missing = [];
    if (!settlement_id) missing.push('settlement_id');
    if (!validator_did) missing.push('validator_did');
    if (!vote) missing.push('vote');
    if (missing.length > 0) {
      return whiteGlove.missingFields(res, { missing, endpoint: 'POST /v1/clear/vote' });
    }

    const result = submitVote({ settlement_id, validator_did, vote, reason });
    if (result.error) {
      // Check if this is a consensus-related failure
      if (result.code === 404 && result.error.includes('not pending')) {
        return whiteGlove.consensusFailure(res, {
          settlement_id,
          reason: result.error,
        });
      }
      return res.status(result.code || 400).json({
        error: result.error,
        error_id: whiteGlove.generateErrorId(),
        recovery_actions: [
          { action: 'retry', description: 'Check the settlement status and retry' },
        ],
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[consensus/vote] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'vote' });
  }
});

// GET /v1/clear/consensus/status
router.get('/consensus/status', (req, res) => {
  try {
    const status = getConsensusStatus();
    res.json(status);
  } catch (err) {
    console.error('[consensus/status] Error:', err.message);
    return whiteGlove.serverError(res, { message: 'Internal server error', context: 'consensus_status' });
  }
});

module.exports = router;
