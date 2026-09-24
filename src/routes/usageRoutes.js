const express = require('express');
const router = express.Router();
const BillingService = require('../services/billingService');
const { validateTenant } = require('../middleware/validation');

const billingService = new BillingService();

function handleGetUsage(req, res, next) {
  try {
    const tenantId = req.tenantId;
    const result = billingService.getTenantUsageRollup(tenantId);

    if (result.error) {
      return res.status(result.statusCode || 400).json({
        error: result.error,
        message: result.message,
      });
    }

    return res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
}

router.get('/usage', validateTenant, handleGetUsage);
router.get('/api/v1/usage', validateTenant, handleGetUsage);

module.exports = router;
