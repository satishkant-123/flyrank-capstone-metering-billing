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

function setupTestEnvironment() {
  const db = new DatabaseSync(':memory:');
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);

  // Seed plans
  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `).run('free', 'Free Tier', 1000, 100000, 0);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  // Tenant 1: Boundary Test Tenant
  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id) VALUES (?, ?, ?, ?)').run(
    'tenant_boundary', 'Boundary Co', 'boundary@test.com', 'free'
  );
  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end) VALUES (?, ?, ?, ?, ?, ?)').run(
    'sub_boundary', 'tenant_boundary', 'free', 'active', start, end
  );

  // Tenant 2: Lapsed/Past-due Tenant
  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id) VALUES (?, ?, ?, ?)').run(
    'tenant_lapsed', 'Lapsed Corp', 'lapsed@test.com', 'free'
  );
  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end) VALUES (?, ?, ?, ?, ?, ?)').run(
    'sub_lapsed', 'tenant_lapsed', 'free', 'past_due', start, end
  );

  const AlertRepository = require('../../src/repositories/alertRepository');
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

  return { db, meterService, usageRepo, now, start };
}

test('PROBE 2: Drive a tenant to its exact quota (999 -> 1000 -> 1001) with 429 response', () => {
  const { db, meterService, usageRepo, start } = setupTestEnvironment();
  const tenantId = 'tenant_boundary';

  // Pre-seed 999 API calls in the database
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES (?, ?, 'api_call', ?, ?, ?)
  `).run('evt_seed_999', tenantId, 999, 999 * 100, start);

  // Verify rollup before boundary call
  const initialRollup = usageRepo.getRollup(tenantId, start, new Date().toISOString());
  assert.equal(initialRollup.total_api_calls, 999);

  // 1. CALL AT BOUNDARY (At 999 of 1,000 calls, request 1 call)
  // Expected: ALLOWED (200 OK), brings usage to exactly 1,000
  const boundaryCall = meterService.record({
    tenantId,
    eventType: 'api_call',
    apiCallCount: 1,
    idempotencyKey: 'key_call_1000',
  });

  assert.equal(boundaryCall.statusCode, 200, 'Call 1,000 of 1,000 must be allowed');
  assert.equal(boundaryCall.body.success, true);
  assert.equal(boundaryCall.body.quota_balance.used, 1000);
  assert.equal(boundaryCall.body.quota_balance.remaining, 0);

  // 2. CALL PAST BOUNDARY (At 1,000 of 1,000 calls, request 1 call)
  // Expected: REJECTED with 429 Too Many Requests & Retry-After header
  const exceededCall = meterService.record({
    tenantId,
    eventType: 'api_call',
    apiCallCount: 1,
    idempotencyKey: 'key_call_1001',
  });

  assert.equal(exceededCall.statusCode, 429, 'Call 1,001 must return 429 Too Many Requests');
  assert.equal(exceededCall.body.error, 'quota_exceeded');
  assert.equal(exceededCall.body.limit, 1000);
  assert.equal(exceededCall.body.used, 1000);
  assert.equal(exceededCall.body.requested, 1);
  assert.equal(exceededCall.headers['Retry-After'], '3600');
  assert.match(exceededCall.body.message, /quota exceeded/i);

  // Verify database usage count remained at 1,000 (rejected request must not record an event!)
  const finalRollup = usageRepo.getRollup(tenantId, start, new Date().toISOString());
  assert.equal(finalRollup.total_api_calls, 1000);
});

test('Quota boundary - AI token quota boundary enforcement', () => {
  const { db, meterService, start } = setupTestEnvironment();
  const tenantId = 'tenant_boundary';

  // Reset usage events
  db.prepare('DELETE FROM usage_events WHERE tenant_id = ?').run(tenantId);

  // Pre-seed 99,500 tokens (limit is 100,000)
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, fresh_input_tokens, cost_microcents, created_at)
    VALUES (?, ?, 'ai_tokens', ?, ?, ?, ?)
  `).run('evt_seed_tokens', tenantId, 99500, 99500, 99500 * 150 / 1000, start);

  // Request 600 tokens (99,500 + 600 = 100,100 > 100,000) -> 429
  const overLimit = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: { fresh_input_tokens: 600 },
  });
  assert.equal(overLimit.statusCode, 429);
  assert.equal(overLimit.body.resource, 'ai_tokens');
  assert.equal(overLimit.body.remaining, 500);

  // Request exactly 500 tokens (99,500 + 500 = 100,000) -> Allowed 200
  const exactFit = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: { fresh_input_tokens: 500 },
  });
  assert.equal(exactFit.statusCode, 200);
  assert.equal(exactFit.body.quota_balance.used, 100000);
  assert.equal(exactFit.body.quota_balance.remaining, 0);

  // Next 1 token -> 429
  const nowOver = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: { fresh_input_tokens: 1 },
  });
  assert.equal(nowOver.statusCode, 429);
});

test('Quota - Returns 402 Payment Required when subscription is past_due or canceled', () => {
  const { meterService } = setupTestEnvironment();
  const tenantId = 'tenant_lapsed';

  const res = meterService.record({
    tenantId,
    eventType: 'api_call',
    apiCallCount: 1,
  });

  assert.equal(res.statusCode, 402, 'Lapsed subscription must return 402 Payment Required');
  assert.equal(res.body.error, 'payment_required');
  assert.equal(res.body.subscription_status, 'past_due');
  assert.match(res.body.message, /past_due/);
});
