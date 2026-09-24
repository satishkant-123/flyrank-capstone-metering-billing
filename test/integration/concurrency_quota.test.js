const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MeterService = require('../../src/services/meterService');
const UsageEventRepository = require('../../src/repositories/usageEventRepository');
const IdempotencyRepository = require('../../src/repositories/idempotencyRepository');
const TenantRepository = require('../../src/repositories/tenantRepository');
const PlanRepository = require('../../src/repositories/planRepository');
const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
const AlertRepository = require('../../src/repositories/alertRepository');
const QuotaService = require('../../src/services/quotaService');

test('Concurrency Safety - Prevents quota race condition when requests arrive simultaneously at boundary', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);

  // Free plan: 1,000 calls
  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES ('free', 'Free Tier', 1000, 100000, 0)
  `).run();

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?, datetime(\'now\'))').run(
    'tenant_race_1', 'Race Co', 'race@test.com', 'free', null
  );

  db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(
    'sub_race_1', 'tenant_race_1', 'free', 'active', start, end, null, null
  );

  // Pre-seed exactly 999 calls
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES ('evt_pre_999_race', 'tenant_race_1', 'api_call', 999, 99900, datetime('now'))
  `).run();

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageEventRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const alertRepo = new AlertRepository(db);
  const quotaService = new QuotaService({ tenantRepo, planRepo, subRepo, usageRepo, alertRepo });

  const meterService = new MeterService({
    db,
    usageRepo,
    idempotencyRepo,
    quotaService,
  });

  // Dispatch two concurrent calls both trying to claim the final 1,000th slot
  const [resA, resB] = await Promise.all([
    new Promise((resolve) => {
      const r = meterService.record({
        tenantId: 'tenant_race_1',
        eventType: 'api_call',
        apiCallCount: 1,
        idempotencyKey: 'race_key_A',
      });
      resolve(r);
    }),
    new Promise((resolve) => {
      const r = meterService.record({
        tenantId: 'tenant_race_1',
        eventType: 'api_call',
        apiCallCount: 1,
        idempotencyKey: 'race_key_B',
      });
      resolve(r);
    }),
  ]);

  const statusCodes = [resA.statusCode, resB.statusCode].sort();

  // Exactly one request must succeed (200) and the second must be rejected (429)
  assert.deepEqual(statusCodes, [200, 429], 'Concurrent calls at boundary must allow exactly one and reject the other');

  // Verify database count is capped at exactly 1000
  const rollup = usageRepo.getRollup('tenant_race_1', start, new Date().toISOString());
  assert.equal(rollup.total_api_calls, 1000, 'Total calls must never exceed the plan limit of 1000 under concurrent race');
});
