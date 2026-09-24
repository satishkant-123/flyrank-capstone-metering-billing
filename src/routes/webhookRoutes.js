const express = require('express');
const router = express.Router();
const StripeService = require('../services/stripeService');
const WebhookService = require('../services/webhookService');

const stripeService = new StripeService();
const webhookService = new WebhookService();

// IMPORTANT: raw body is required for cryptographic signature verification
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res, next) => {
  const sig = req.headers['stripe-signature'];
  const rawBody = req.body;

  let event;
  try {
    event = stripeService.constructWebhookEvent(rawBody, sig);
  } catch (err) {
    console.warn('[Webhook] Signature verification failed:', err.message);
    return res.status(400).json({
      error: 'invalid_signature',
      message: 'Cryptographic webhook signature verification failed.',
    });
  }

  try {
    const result = webhookService.processEvent(event);
    return res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
