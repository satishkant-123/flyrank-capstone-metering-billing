const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');
const generateRoutes = require('./routes/generateRoutes');
const usageRoutes = require('./routes/usageRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const adminRoutes = require('./routes/adminRoutes');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  // 1. Mount Stripe webhook routes BEFORE standard express.json()
  // to ensure access to pristine raw request buffer for signature verification
  app.use(webhookRoutes);

  // 2. Standard JSON body parser for all other endpoints
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 3. API Routes
  app.use(generateRoutes);
  app.use(usageRoutes);
  app.use(checkoutRoutes);
  app.use(invoiceRoutes);
  app.use('/api/v1', adminRoutes);

  // Root welcome / status endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'LLM Usage Metering & Billing Engine',
      version: '1.0.0',
      status: 'active',
      endpoints: {
        billable: 'POST /generate (or /api/v1/generate)',
        usage: 'GET /usage?tenant_id=:id',
        checkout: 'POST /checkout/create-session',
        webhook: 'POST /webhooks/stripe',
        invoices: 'GET /invoices (with x-tenant-id header)',
        health: 'GET /api/v1/health',
      },
    });
  });

  // 4. Centralized Error Handling
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
