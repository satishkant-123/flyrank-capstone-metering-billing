const createApp = require('./app');
const config = require('./config/env');
const { getDatabase, runMigrations } = require('./db/connection');
const { seedDatabase } = require('./db/seed');
const ReconciliationJob = require('./jobs/reconciliationJob');
const UsageAlertJob = require('./jobs/usageAlertJob');

async function main() {
  const db = getDatabase();
  console.log('[Database] Running migrations...');
  runMigrations(db);

  // Seed plans and baseline tenants if not yet populated
  const planCheck = db.prepare('SELECT COUNT(*) as count FROM plans').get();
  if (!planCheck || planCheck.count === 0) {
    console.log('[Database] Seeding initial data...');
    seedDatabase(db);
  }

  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(`[Server] Usage Metering & Billing Engine running on port ${config.port}`);
    console.log(`[Server] Environment: ${config.nodeEnv}`);
    console.log(`[Server] Base URL: ${config.baseUrl}`);
  });

  // Start periodic background jobs in production/development
  if (config.nodeEnv !== 'test') {
    const reconciliationJob = new ReconciliationJob();
    const usageAlertJob = new UsageAlertJob();

    // Run usage alert job every 5 minutes
    const alertInterval = setInterval(() => {
      try {
        usageAlertJob.run();
      } catch (err) {
        console.error('[UsageAlertJob] Periodic run failed:', err.message);
      }
    }, 5 * 60 * 1000);

    // Run reconciliation job hourly
    const reconcileInterval = setInterval(async () => {
      try {
        await reconciliationJob.run();
      } catch (err) {
        console.error('[ReconciliationJob] Periodic run failed:', err.message);
      }
    }, 60 * 60 * 1000);

    const shutdown = () => {
      console.log('\n[Server] Shutting down gracefully...');
      clearInterval(alertInterval);
      clearInterval(reconcileInterval);
      server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return server;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Fatal] Server failed to start:', err);
    process.exit(1);
  });
}

module.exports = { main };
