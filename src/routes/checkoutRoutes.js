const express = require('express');
const router = express.Router();
const StripeService = require('../services/stripeService');
const { validateTenant } = require('../middleware/validation');

const stripeService = new StripeService();

router.post('/checkout/create-session', validateTenant, async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const { success_url, cancel_url } = req.body || {};

    const session = await stripeService.createCheckoutSession({
      tenantId,
      successUrl: success_url,
      cancelUrl: cancel_url,
    });

    return res.status(200).json({
      success: true,
      session_id: session.sessionId,
      checkout_url: session.url,
      mock: !!session.mock,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
