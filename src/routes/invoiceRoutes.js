const express = require('express');
const router = express.Router();
const BillingService = require('../services/billingService');
const { validateTenant } = require('../middleware/validation');

const billingService = new BillingService();

router.get('/invoices', validateTenant, (req, res, next) => {
  try {
    const result = billingService.generateInvoiceStatement(req.tenantId);
    if (result.error) {
      return res.status(result.statusCode || 400).json(result);
    }
    return res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
});

router.get('/invoices/:tenant_id', (req, res, next) => {
  try {
    const tenantId = req.params.tenant_id;
    const result = billingService.generateInvoiceStatement(tenantId);
    if (result.error) {
      return res.status(result.statusCode || 400).json(result);
    }
    return res.status(200).json(result.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
