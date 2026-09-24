const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ReconciliationJob = require('../../src/jobs/reconciliationJob');
const UsageAlertJob = require('../../src/jobs/usageAlertJob');
const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
const TenantRepository = require('../../src/repositories/tenantRepository');
const PlanRepository = require('../../src/repositories/planRepository');
const UsageEventRepository = require('../../src/repositories/usageEventRepository');
const AlertRepository = require('../../src/repositories/alertRepository');

function setupJobsTestDb() {
  const db = new DatabaseSync(':memory:');
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);

  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `).run('free', 'Free Tier', 1000, 100000, 0);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id) VALUES (?, ?, ?, ?)').run(
    'tenant_job_1', 'Alert Test Tenant', 'alerts@test.com', 'free'
  );

  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end, stripe_subscription_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'sub_job_1', 'tenant_job_1', 'free', 'active', start, end, 'sub_stripe_drift_1'
  );

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageEventRepository(db);
  const alertRepo = new AlertRepository(db);

  return { db, tenantRepo, planRepo, subRepo, usageRepo, alertRepo, start };
}

test('Background Job - Reconciliation synchronizes desynchronized subscription status from Stripe', async () => {
  const { subRepo, tenantRepo } = setupJobsTestDb();

  // Mock Stripe client returning past_due status (drift from local active)
  const mockStripeService = {
    secretKey: 'sk_test_mock',
    stripe: {
      subscriptions: {
        retrieve: async (subId) => {
          if (subId === 'sub_stripe_drift_1') {
            return { id: subId, status: 'past_due' };
          }
          return null;
        },
      },
    },
  };

  const reconciliationJob = new ReconciliationJob({
    subRepo,
    tenantRepo,
    stripeService: mockStripeService,
  });

  const report = await reconciliationJob.run();
  assert.equal(report.checkedCount, 1);
  assert.equal(report.syncedCount, 1);
  assert.equal(report.anomaliesCount, 1);
  assert.equal(report.anomalies[0].action, 'SYNCHRONIZED');

  // Verify DB was updated
  const updatedSub = subRepo.getByTenantId('tenant_job_1');
  assert.equal(updatedSub.status, 'past_due');
});

test('Background Job - Usage alert triggers at 80% and 100% threshold', () => {
  const { tenantRepo, planRepo, subRepo, usageRepo, alertRepo, db, start } = setupJobsTestDb();
  const alertJob = new UsageAlertJob({ tenantRepo, planRepo, subRepo, usageRepo, alertRepo });

  // 1. Initial run: 0% usage -> no alerts
  const run1 = alertJob.run();
  assert.equal(run1.alertsCount, 0);

  // 2. Add 850 calls (85% of 1,000 limit)
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES (?, ?, 'api_call', ?, ?, ?)
  `).run('evt_alert_850', 'tenant_job_1', 850, 850 * 100, start);

  const run2 = alertJob.run();
  assert.equal(run2.alertsCount, 1);
  assert.equal(run2.alerts[0].threshold, 80);
  assert.equal(run2.alerts[0].resource, 'api_calls');

  // Re-run should NOT duplicate alert in same period
  const run2Repeat = alertJob.run();
  assert.equal(run2Repeat.alertsCount, 0);

  // 3. Add remaining calls to reach 100% (1,000 calls)
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES (?, ?, 'api_call', ?, ?, ?)
  `).run('evt_alert_150', 'tenant_job_1', 150, 150 * 100, start);

  const run3 = alertJob.run();
  assert.equal(run3.alertsCount, 1);
  assert.equal(run3.alerts[0].threshold, 100);
});
