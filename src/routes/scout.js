const express = require('express');
const router = express.Router();
const { scanForCandidates, recruitCandidate, getPipelineStats } = require('../services/scout');

// POST /v1/clear/scout/scan
router.post('/scan', async (req, res) => {
  try {
    const result = await scanForCandidates();
    res.json(result);
  } catch (err) {
    console.error('[scout/scan] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/clear/scout/recruit/:did
router.post('/recruit/:did', async (req, res) => {
  try {
    const result = await recruitCandidate(req.params.did);
    res.json(result);
  } catch (err) {
    console.error('[scout/recruit] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/scout/pipeline
router.get('/pipeline', async (req, res) => {
  try {
    const stats = await getPipelineStats();
    res.json(stats);
  } catch (err) {
    console.error('[scout/pipeline] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
