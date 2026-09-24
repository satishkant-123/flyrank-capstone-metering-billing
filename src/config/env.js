require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || './data/metering.db',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_mock_key',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder_mock_secret',
    proPriceId: process.env.STRIPE_PRO_PRICE_ID || 'price_mock_pro_monthly',
  },
};

module.exports = config;
