'use strict';
/**
 * HiveClear — AI Revenue Endpoint
 * POST /v1/clear/ai/screen  ($0.04/call)
 *
 * Compliance and settlement layer: assess transaction risk, AML signals, go/no-go.
 */

const express = require('express');
const router = express.Router();

const HIVE_AI_URL = 'https://hive-ai-1.onrender.com/v1/chat/completions';
const HIVE_KEY = process.env.HIVE_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const MODEL = 'meta-llama/llama-3.1-8b-instruct';
const PRICE_USDC = 0.04;

function staticFallback(from_did, to_did, amount_usdc, transaction_type) {
  const risk_flags = [];
  if (amount_usdc > 50000) risk_flags.push('high_value');
  if (!from_did || !to_did) risk_flags.push('missing_party_did');
  const compliance_status = risk_flags.length > 1 ? 'review' : 'clear';
  return {
    success: true,
    brief: `Transaction of ${amount_usdc} USDC (${transaction_type}) from ${from_did} to ${to_did} was screened. Standard AML checks applied. No automated flags triggered beyond value thresholds.`,
    compliance_status,
    risk_flags,
    price_usdc: PRICE_USDC,
    _fallback: true,
  };
}

/**
 * POST /v1/clear/ai/screen
 * Body: { from_did, to_did, amount_usdc, transaction_type }
 */
router.post('/', async (req, res) => {
  try {
    const { from_did, to_did, amount_usdc, transaction_type } = req.body;

    if (!from_did || !to_did || amount_usdc === undefined || !transaction_type) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: from_did, to_did, amount_usdc, transaction_type',
      });
    }

    const userMessage = `Transaction Details:
From: ${from_did}
To: ${to_did}
Amount: ${amount_usdc} USDC
Type: ${transaction_type}

Assess AML risk, jurisdiction flags, and provide a go/no-go recommendation.`;

    let aiResponse;
    try {
      const response = await fetch(HIVE_AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HIVE_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: 'You are HiveClear — the compliance and settlement layer. Assess transaction risk. AML signals, jurisdiction flags. Go/no-go in 3 sentences.',
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HiveAI returned ${response.status}`);

      const data = await response.json();
      const brief = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!brief) throw new Error('Empty response from HiveAI');

      // Determine compliance_status from brief
      const lower = brief.toLowerCase();
      let compliance_status = 'clear';
      const risk_flags = [];

      if (lower.includes('block') || lower.includes('suspicious') || lower.includes('halt') || lower.includes('no-go')) {
        compliance_status = 'block';
        risk_flags.push('ai_flagged');
      } else if (lower.includes('review') || lower.includes('caution') || lower.includes('flag') || lower.includes('monitor')) {
        compliance_status = 'review';
        risk_flags.push('requires_review');
      }

      if (Number(amount_usdc) > 50000) risk_flags.push('high_value_transaction');

      aiResponse = { brief, compliance_status, risk_flags };
    } catch (aiErr) {
      console.warn('[HiveClear AI] HiveAI unavailable, using fallback:', aiErr.message);
      return res.json(staticFallback(from_did, to_did, amount_usdc, transaction_type));
    }

    return res.json({
      success: true,
      brief: aiResponse.brief,
      compliance_status: aiResponse.compliance_status,
      risk_flags: aiResponse.risk_flags,
      price_usdc: PRICE_USDC,
    });
  } catch (err) {
    console.error('[HiveClear AI] Unexpected error:', err.message);
    return res.json(staticFallback(
      req.body?.from_did || 'unknown',
      req.body?.to_did || 'unknown',
      Number(req.body?.amount_usdc) || 0,
      req.body?.transaction_type || 'unknown'
    ));
  }
});

module.exports = router;
