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
const QuotaService = require('../../src/services/quotaService');
const { PRICING } = require('../../src/config/pricing');

function createIsolatedTestDb() {
  const db = new DatabaseSync(':memory:');
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);

  // Seed plans
  const insertPlan = db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertPlan.run('free', 'Free Tier', 1000, 100000, 0);
  insertPlan.run('pro', 'Pro Tier', 50000, 10000000, 29000000);

  // Seed tenant & active subscription
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  db.prepare(`
    INSERT INTO tenants (id, name, email, current_plan_id)
    VALUES (?, ?, ?, ?)
  `).run('tenant_idem_1', 'Idem Org', 'idem@test.com', 'free');

  db.prepare(`
    INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('sub_idem_1', 'tenant_idem_1', 'free', 'active', start, end);

  return db;
}

test('PROBE 1: Send the same billable request twice with one idempotency key -> exactly one usage event', () => {
  const db = createIsolatedTestDb();
  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageEventRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const quotaService = new QuotaService({ tenantRepo, planRepo, subRepo, usageRepo });

  const meterService = new MeterService({
    db,
    usageRepo,
    idempotencyRepo,
    quotaService,
  });

  const tenantId = 'tenant_idem_1';
  const idempotencyKey = 'req_idempotency_key_12345';
  const requestPayload = {
    prompt: 'Generate an analysis report',
    simulate_tokens: {
      cached_input_tokens: 1000,
      fresh_input_tokens: 2000,
      output_tokens: 500,
      reasoning_tokens: 100,
    },
  };

  // FIRST CALL
  const res1 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: requestPayload.simulate_tokens,
    idempotencyKey,
    requestPayload,
  });

  assert.equal(res1.statusCode, 200);
  assert.equal(res1.isIdempotentReplay, false);
  assert.equal(res1.body.success, true);
  assert.equal(res1.body.quantity, 3600); // 1000 + 2000 + 500 + 100
  const initialEventId = res1.body.event_id;

  // Check database row count
  const eventRowsAfterFirst = db.prepare('SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ?').get(tenantId);
  assert.equal(eventRowsAfterFirst.count, 1, 'Exactly one usage event must exist after first call');

  // SECOND CALL (Exact same request with same idempotency key)
  const res2 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: requestPayload.simulate_tokens,
    idempotencyKey,
    requestPayload,
  });

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.isIdempotentReplay, true, 'Second call must be flagged as idempotent replay');
  assert.equal(res2.body.event_id, initialEventId, 'Second response must mirror the first response exactly');
  assert.deepEqual(res1.body, res2.body, 'Both response bodies must match completely');

  // Verify database still has EXACTLY 1 row (no double counting!)
  const eventRowsAfterSecond = db.prepare('SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ?').get(tenantId);
  assert.equal(eventRowsAfterSecond.count, 1, 'Still exactly one usage event after retry');
});

test('Idempotency - Reusing key with different request payload triggers 409 Conflict', () => {
  const db = createIsolatedTestDb();
  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageEventRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const quotaService = new QuotaService({ tenantRepo, planRepo, subRepo, usageRepo });

  const meterService = new MeterService({
    db,
    usageRepo,
    idempotencyRepo,
    quotaService,
  });

  const tenantId = 'tenant_idem_1';
  const idempotencyKey = 'key_payload_conflict_test';

  const res1 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: { fresh_input_tokens: 500, output_tokens: 100 },
    idempotencyKey,
    requestPayload: { prompt: 'original prompt' },
  });
  assert.equal(res1.statusCode, 200);

  // Attempt second call with DIFFERENT prompt/payload
  const res2 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: { fresh_input_tokens: 500, output_tokens: 100 },
    idempotencyKey,
    requestPayload: { prompt: 'completely different tampered payload' },
  });

  assert.equal(res2.statusCode, 409);
  assert.equal(res2.body.error, 'idempotency_conflict');
});
