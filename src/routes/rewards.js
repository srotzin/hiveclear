const express = require('express');
const router = express.Router();
const { getRewardBalance, distributeRewards, getRewardPool } = require('../services/rewards');

// GET /v1/clear/rewards/pool — must be before /:did to avoid matching "pool" as did
router.get('/pool', async (req, res) => {
  try {
    const pool = await getRewardPool();
    res.json(pool);
  } catch (err) {
    console.error('[rewards/pool] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/clear/rewards/distribute
router.post('/distribute', async (req, res) => {
  try {
    const result = await distributeRewards();
    res.json(result);
  } catch (err) {
    console.error('[rewards/distribute] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/rewards/:did
router.get('/:did', async (req, res) => {
  try {
    const balance = await getRewardBalance(req.params.did);
    res.json(balance);
  } catch (err) {
    console.error('[rewards/get] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
