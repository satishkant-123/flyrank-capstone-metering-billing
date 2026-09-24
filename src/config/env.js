require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || './data/metering.db',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || 'mock_test_secret_key_placeholder',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'mock_test_webhook_secret_placeholder',
    proPriceId: process.env.STRIPE_PRO_PRICE_ID || 'price_mock_pro_monthly',
  },
};

module.exports = config;
