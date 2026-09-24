const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ReconciliationJob = require('../../src/jobs/reconciliationJob');
const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
const TenantRepository = require('../../src/repositories/tenantRepository');
const PlanRepository = require('../../src/repositories/planRepository');
const JobFailureAlertRepository = require('../../src/repositories/jobFailureAlertRepository');

function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  const sql001 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql001);
  const sql002 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/002_job_failure_alerts.sql'), 'utf8');
  db.exec(sql002);

  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `).run('free', 'Free Tier', 1000, 100000, 0);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id) VALUES (?, ?, ?, ?)').run(
    'tenant_retry_1', 'Retry Corp', 'retry@corp.test', 'free'
  );

  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end, stripe_subscription_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'sub_retry_1', 'tenant_retry_1', 'free', 'active', start, end, 'sub_stripe_retry_1'
  );

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const jobFailureAlertRepo = new JobFailureAlertRepository(db);

  return { db, tenantRepo, planRepo, subRepo, jobFailureAlertRepo };
}

test('Job Retry: Retry mechanism succeeds on transient failure (Attempt 1 fail -> Attempt 2 success)', async () => {
  const { db, subRepo, tenantRepo, jobFailureAlertRepo } = setupTestDb();

  let callCount = 0;
  const mockStripeService = {
    stripe: {
      subscriptions: {
        retrieve: async (subId) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Transient 500 Network Timeout');
          }
          return { id: subId, status: 'past_due' };
        },
      },
    },
  };

  const job = new ReconciliationJob({
    db,
    subRepo,
    tenantRepo,
    jobAlertRepo: jobFailureAlertRepo,
    stripeService: mockStripeService,
  });

  const report = await job.run();
  assert.equal(callCount, 2, 'Should have made exactly 2 attempts');
  assert.equal(report.status, 'HEALTHY');
  assert.equal(report.syncedCount, 1);

  // Check audit log
  const audit = report.retryAuditLog[0].retryResult;
  assert.equal(audit.success, true);
  assert.equal(audit.attempts, 2);
  assert.equal(audit.attemptsLog[0].status, 'failed');
  assert.equal(audit.attemptsLog[1].status, 'succeeded');

  // No failure alert should be created on success
  const alerts = jobFailureAlertRepo.getAllAlerts();
  assert.equal(alerts.length, 0);
});

test('Job Retry: Retries exhausted after 3 attempts creates persistent alert in job_failure_alerts table', async () => {
  const { db, subRepo, tenantRepo, jobFailureAlertRepo } = setupTestDb();

  let callCount = 0;
  const mockStripeService = {
    stripe: {
      subscriptions: {
        retrieve: async () => {
          callCount++;
          throw new Error('Persistent 503 Backend Service Unavailable');
        },
      },
    },
  };

  const job = new ReconciliationJob({
    db,
    subRepo,
    tenantRepo,
    jobAlertRepo: jobFailureAlertRepo,
    stripeService: mockStripeService,
  });

  const report = await job.run();
  assert.equal(callCount, 3, 'Should have made exactly 3 attempts');
  assert.equal(report.status, 'ALERT_TRIGGERED');

  // Check that alert was persisted to database table job_failure_alerts
  const alerts = jobFailureAlertRepo.getAllAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].job_name, 'reconciliation');
  assert.equal(alerts[0].attempts, 3);
  assert.match(alerts[0].error_message, /Persistent 503 Backend Service Unavailable/);
  assert.equal(alerts[0].alert_status, 'DISPATCHED');
});
