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
const JobAlertRepository = require('../../src/repositories/jobAlertRepository');

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
  const jobAlertRepo = new JobAlertRepository(db);

  return { db, tenantRepo, planRepo, subRepo, usageRepo, alertRepo, jobAlertRepo, start };
}

test('Background Job - Retry mechanism succeeds on retry attempt (Attempt 1 fail -> Attempt 2 success)', async () => {
  const { subRepo, tenantRepo, jobAlertRepo, db } = setupJobsTestDb();

  let callCount = 0;
  const mockStripeService = {
    stripe: {
      subscriptions: {
        retrieve: async (subId) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Transient network timeout');
          }
          return { id: subId, status: 'past_due' };
        },
      },
    },
  };

  const reconciliationJob = new ReconciliationJob({
    db,
    subRepo,
    tenantRepo,
    jobAlertRepo,
    stripeService: mockStripeService,
  });

  const report = await reconciliationJob.run();
  assert.equal(callCount, 2, 'Should have retried after first failure');
  assert.equal(report.checkedCount, 1);
  assert.equal(report.syncedCount, 1);
  assert.equal(report.status, 'HEALTHY');

  // Verify retry audit log shows Attempt 1 failed and Attempt 2 succeeded
  const audit = report.retryAuditLog[0].retryResult;
  assert.equal(audit.success, true);
  assert.equal(audit.attempts, 2);
  assert.equal(audit.attemptsLog[0].status, 'failed');
  assert.equal(audit.attemptsLog[1].status, 'succeeded');
});

test('Background Job - Retries exhausted (3 attempts) generates failure alert in job_failure_alerts', async () => {
  const { subRepo, tenantRepo, jobAlertRepo, db } = setupJobsTestDb();

  let callCount = 0;
  const mockStripeService = {
    stripe: {
      subscriptions: {
        retrieve: async () => {
          callCount++;
          throw new Error('Persistent 503 Service Unavailable');
        },
      },
    },
  };

  const reconciliationJob = new ReconciliationJob({
    db,
    subRepo,
    tenantRepo,
    jobAlertRepo,
    stripeService: mockStripeService,
  });

  const report = await reconciliationJob.run();
  assert.equal(callCount, 3, 'Must attempt exactly 3 retries before failing permanently');
  assert.equal(report.status, 'ALERT_TRIGGERED');
  assert.equal(report.anomalies[0].action, 'FAILURE_ALERT_DISPATCHED');
  assert.ok(report.anomalies[0].alertId);

  // Verify failure alert is recorded in database table
  const recordedAlerts = jobAlertRepo.getAllAlerts();
  assert.equal(recordedAlerts.length, 1);
  assert.equal(recordedAlerts[0].job_name, 'reconciliation');
  assert.equal(recordedAlerts[0].attempts, 3);
  assert.match(recordedAlerts[0].error_message, /Persistent 503/);
  assert.equal(recordedAlerts[0].alert_status, 'DISPATCHED');
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
