const express = require('express');
const router = express.Router();
const { enrollValidatorFromDid, getValidators, getValidator, withdrawValidator, recordHeartbeat } = require('../services/validator');

// POST /v1/clear/validators/enroll
router.post('/enroll', async (req, res) => {
  try {
    const { did } = req.body;
    if (!did) return res.status(400).json({ error: 'did is required' });

    const result = await enrollValidatorFromDid(did);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });

    res.status(201).json(result);
  } catch (err) {
    console.error('[validators/enroll] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/validators
router.get('/', async (req, res) => {
  try {
    const validators = await getValidators();
    res.json({ validators, total: validators.length });
  } catch (err) {
    console.error('[validators/list] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/clear/validators/:did
router.get('/:did', async (req, res) => {
  try {
    const validator = await getValidator(req.params.did);
    if (!validator) return res.status(404).json({ error: 'Validator not found' });
    res.json(validator);
  } catch (err) {
    console.error('[validators/get] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/clear/validators/withdraw/:did
router.post('/withdraw/:did', async (req, res) => {
  try {
    const result = await withdrawValidator(req.params.did);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[validators/withdraw] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/clear/validators/heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    const { did } = req.body;
    if (!did) return res.status(400).json({ error: 'did is required' });

    const result = await recordHeartbeat(did);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[validators/heartbeat] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
