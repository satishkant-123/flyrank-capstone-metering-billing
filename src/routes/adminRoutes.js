const express = require('express');
const router = express.Router();
const ReconciliationJob = require('../jobs/reconciliationJob');
const UsageAlertJob = require('../jobs/usageAlertJob');
const { getDatabase } = require('../db/connection');

const reconciliationJob = new ReconciliationJob();
const usageAlertJob = new UsageAlertJob();

router.get('/health', (req, res) => {
  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
    return res.status(200).json({ status: 'healthy', uptime: process.uptime() });
  } catch (err) {
    return res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

router.post('/jobs/reconcile', async (req, res, next) => {
  try {
    const result = await reconciliationJob.run();
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/alerts', (req, res, next) => {
  try {
    const result = usageAlertJob.run();
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
