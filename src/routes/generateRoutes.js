const express = require('express');
const router = express.Router();
const MeterService = require('../services/meterService');
const { validateTenant, validateGenerateRequest } = require('../middleware/validation');

const meterService = new MeterService();

function handleGenerate(req, res, next) {
  try {
    const tenantId = req.tenantId;
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
    const eventType = req.body?.event_type || 'ai_tokens';
    const apiCallCount = req.body?.api_call_count || 1;

    let tokenBreakdown = {};
    if (eventType === 'ai_tokens') {
      const source = req.body?.simulate_tokens || req.body?.tokens || req.body || {};
      const hasTokenFields = source.cached_input_tokens !== undefined ||
                             source.fresh_input_tokens !== undefined ||
                             source.input_tokens !== undefined ||
                             source.output_tokens !== undefined ||
                             source.reasoning_tokens !== undefined;

      if (hasTokenFields) {
        tokenBreakdown = {
          cached_input_tokens: source.cached_input_tokens || 0,
          fresh_input_tokens: source.fresh_input_tokens !== undefined ? source.fresh_input_tokens : (source.input_tokens || 0),
          output_tokens: source.output_tokens || 0,
          reasoning_tokens: source.reasoning_tokens || 0,
        };
      } else {
        // Fallback default simulation: 1,000 fresh input tokens + 500 output tokens
        tokenBreakdown = {
          fresh_input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 500,
          reasoning_tokens: 0,
        };
      }
    }

    const result = meterService.record({
      tenantId,
      eventType,
      tokenBreakdown,
      apiCallCount,
      idempotencyKey,
      requestPayload: req.body,
    });

    if (result.isIdempotentReplay) {
      res.setHeader('Idempotent-Replay', 'true');
    }

    if (result.headers) {
      for (const [header, val] of Object.entries(result.headers)) {
        res.setHeader(header, val);
      }
    }

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
}

// Support both POST /generate and API-versioned POST /api/v1/generate
router.post('/generate', validateTenant, validateGenerateRequest, handleGenerate);
router.post('/api/v1/generate', validateTenant, validateGenerateRequest, handleGenerate);
router.post('/api/v1/meter', validateTenant, validateGenerateRequest, handleGenerate);

module.exports = router;
