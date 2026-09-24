const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MeterService = require('../../src/services/meterService');
const BillingService = require('../../src/services/billingService');
const UsageEventRepository = require('../../src/repositories/usageEventRepository');
const IdempotencyRepository = require('../../src/repositories/idempotencyRepository');
const TenantRepository = require('../../src/repositories/tenantRepository');
const PlanRepository = require('../../src/repositories/planRepository');
const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
const AlertRepository = require('../../src/repositories/alertRepository');
const QuotaService = require('../../src/services/quotaService');
const { PRICING, microcentsToUSD } = require('../../src/config/pricing');

function setupRollupTestDb() {
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

  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id) VALUES (?, ?, ?, ?)').run(
    'tenant_rollup_1', 'Rollup Analytics Corp', 'billing@rollup.test', 'free'
  );

  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end) VALUES (?, ?, ?, ?, ?, ?)').run(
    'sub_rollup_1', 'tenant_rollup_1', 'free', 'active', start, end
  );

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

  const billingService = new BillingService({ tenantRepo, planRepo, subRepo, usageRepo });

  return { db, meterService, billingService, tenantRepo, usageRepo };
}

test('PROBE 5: Check pinned pricing rules -> cached-input and reasoning-token rules produce exact expected totals; GET /usage matches', () => {
  const { meterService, billingService } = setupRollupTestDb();
  const tenantId = 'tenant_rollup_1';

  // Event 1: Mixed token request
  // 2,000 cached input (75/1k = 150)
  // 4,000 fresh input (150/1k = 600)
  // 1,000 output (600/1k = 600)
  // 500 reasoning (billed as output: 600/1k = 300)
  // Total expected event 1 cost = 150 + 600 + 600 + 300 = 1,650 microcents ($0.001650)
  const event1 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: {
      cached_input_tokens: 2000,
      fresh_input_tokens: 4000,
      output_tokens: 1000,
      reasoning_tokens: 500,
    },
    idempotencyKey: 'key_event_1',
  });

  assert.equal(event1.statusCode, 200);
  assert.equal(event1.body.cost_microcents, 1650);
  assert.equal(event1.body.cost_usd, '$0.001650');
  assert.equal(event1.body.quantity, 7500);

  // Event 2: API Calls (5 calls @ 100 microcents = 500 microcents)
  const event2 = meterService.record({
    tenantId,
    eventType: 'api_call',
    apiCallCount: 5,
    idempotencyKey: 'key_event_2',
  });

  assert.equal(event2.statusCode, 200);
  assert.equal(event2.body.cost_microcents, 500);
  assert.equal(event2.body.cost_usd, '$0.000500');

  // Event 3: Cached tokens + reasoning tokens only
  // 1,000 cached (75 microcents) + 1,000 reasoning (600 microcents) = 675 microcents ($0.000675)
  const event3 = meterService.record({
    tenantId,
    eventType: 'ai_tokens',
    tokenBreakdown: {
      cached_input_tokens: 1000,
      fresh_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 1000,
    },
    idempotencyKey: 'key_event_3',
  });

  assert.equal(event3.statusCode, 200);
  assert.equal(event3.body.cost_microcents, 675);
  assert.equal(event3.body.cost_usd, '$0.000675');

  // GATE CHECK: Query GET /usage rollup
  const usageResult = billingService.getTenantUsageRollup(tenantId);
  assert.equal(usageResult.statusCode, 200);
  const data = usageResult.data;

  // Verify quotas & quantities
  assert.equal(data.quotas.api_calls.used, 5);
  assert.equal(data.quotas.api_calls.limit, 1000);
  assert.equal(data.quotas.api_calls.remaining, 995);

  assert.equal(data.quotas.ai_tokens.used, 9500); // 7500 + 2000
  assert.equal(data.quotas.ai_tokens.limit, 100000);
  assert.equal(data.quotas.ai_tokens.remaining, 90500);

  // Verify breakdown
  assert.equal(data.token_breakdown.cached_input_tokens, 3000); // 2000 + 1000
  assert.equal(data.token_breakdown.fresh_input_tokens, 4000);  // 4000
  assert.equal(data.token_breakdown.output_tokens, 1000);       // 1000
  assert.equal(data.token_breakdown.reasoning_tokens, 1500);    // 500 + 1000

  // Verify costs match pinned constants exactly
  assert.equal(data.costs.api_calls_microcents, 500);
  assert.equal(data.costs.api_calls_usd, '$0.000500');

  assert.equal(data.costs.ai_tokens_microcents, 2325); // 1650 + 675
  assert.equal(data.costs.ai_tokens_usd, '$0.002325');

  assert.equal(data.costs.usage_total_microcents, 2825); // 2325 + 500
  assert.equal(data.costs.usage_total_usd, '$0.002825');
  assert.equal(data.costs.grand_total_microcents, 2825);
  assert.equal(data.costs.grand_total_usd, '$0.002825');

  // Also verify invoice generation
  const invoiceResult = billingService.generateInvoiceStatement(tenantId);
  assert.equal(invoiceResult.statusCode, 200);
  assert.equal(invoiceResult.data.total_amount_microcents, 2825);
  assert.equal(invoiceResult.data.line_items.length, 6);
});
