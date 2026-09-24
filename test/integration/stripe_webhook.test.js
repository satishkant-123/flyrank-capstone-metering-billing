const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('stripe');

const WebhookService = require('../../src/services/webhookService');
const StripeService = require('../../src/services/stripeService');
const TenantRepository = require('../../src/repositories/tenantRepository');
const PlanRepository = require('../../src/repositories/planRepository');
const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
const WebhookEventRepository = require('../../src/repositories/webhookEventRepository');
const UsageEventRepository = require('../../src/repositories/usageEventRepository');
const BillingService = require('../../src/services/billingService');

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_cryptographic_verification_12345';
const stripe = new Stripe('sk_test_mock_key', { apiVersion: '2023-10-16' });

function setupStripeTestDb() {
  const db = new DatabaseSync(':memory:');
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
  db.exec(sql);

  // Seed plans
  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `).run('free', 'Free Tier', 1000, 100000, 0);

  db.prepare(`
    INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
    VALUES (?, ?, ?, ?, ?)
  `).run('pro', 'Pro Tier', 50000, 10000000, 29000000);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  // Create test tenant on Free plan
  db.prepare('INSERT INTO tenants (id, name, email, current_plan_id, stripe_customer_id) VALUES (?, ?, ?, ?, ?)').run(
    'tenant_stripe_1', 'Stripe Tester Co', 'stripe@tester.com', 'free', 'cus_test_123'
  );
  db.prepare('INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end) VALUES (?, ?, ?, ?, ?, ?)').run(
    'sub_free_init', 'tenant_stripe_1', 'free', 'active', start, end
  );

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const webhookRepo = new WebhookEventRepository(db);
  const usageRepo = new UsageEventRepository(db);

  const webhookService = new WebhookService({ db, webhookRepo, tenantRepo, subRepo });
  const stripeService = new StripeService({ webhookSecret: TEST_WEBHOOK_SECRET });
  const billingService = new BillingService({ tenantRepo, planRepo, subRepo, usageRepo });

  return { db, tenantRepo, planRepo, subRepo, webhookRepo, webhookService, stripeService, billingService };
}

test('PROBE 3: Complete a Stripe test Checkout -> the webhook flips the tenant Free -> Pro; GET /usage shows the new limits', () => {
  const { tenantRepo, subRepo, webhookService, billingService } = setupStripeTestDb();
  const tenantId = 'tenant_stripe_1';

  // Verify initial state: Free tier
  const initialTenant = tenantRepo.getById(tenantId);
  assert.equal(initialTenant.current_plan_id, 'free');

  const initialUsage = billingService.getTenantUsageRollup(tenantId);
  assert.equal(initialUsage.data.plan.id, 'free');
  assert.equal(initialUsage.data.quotas.api_calls.limit, 1000);
  assert.equal(initialUsage.data.quotas.ai_tokens.limit, 100000);

  // Simulated checkout.session.completed event
  const checkoutEvent = {
    id: 'evt_test_checkout_completed_999',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_session_123',
        customer: 'cus_test_123',
        subscription: 'sub_stripe_pro_live_123',
        client_reference_id: tenantId,
        metadata: {
          tenant_id: tenantId,
        },
      },
    },
  };

  // Process webhook
  const result = webhookService.processEvent(checkoutEvent);
  assert.equal(result.success, true);
  assert.equal(result.duplicate, false);

  // GATE CHECK: Test Checkout flips a tenant Free -> Pro via webhook
  const updatedTenant = tenantRepo.getById(tenantId);
  assert.equal(updatedTenant.current_plan_id, 'pro', 'Tenant plan must now be Pro');

  const updatedSub = subRepo.getByTenantId(tenantId);
  assert.equal(updatedSub.plan_id, 'pro');
  assert.equal(updatedSub.status, 'active');
  assert.equal(updatedSub.stripe_subscription_id, 'sub_stripe_pro_live_123');

  // Verify GET /usage shows the upgraded Pro limits (50,000 calls & 10M tokens)
  const updatedUsage = billingService.getTenantUsageRollup(tenantId);
  assert.equal(updatedUsage.data.plan.id, 'pro');
  assert.equal(updatedUsage.data.quotas.api_calls.limit, 50000);
  assert.equal(updatedUsage.data.quotas.ai_tokens.limit, 10000000);
});

test('PROBE 4: Send a forged webhook (bad signature) -> 400, nothing changes. Replay a real event twice -> processed once', () => {
  const { tenantRepo, webhookRepo, stripeService, webhookService } = setupStripeTestDb();
  const tenantId = 'tenant_stripe_1';

  const rawPayload = JSON.stringify({
    id: 'evt_forged_attempt_111',
    type: 'checkout.session.completed',
    data: { object: { metadata: { tenant_id: tenantId } } },
  });

  // 1. FORGED WEBHOOK: Invalid signature
  const forgedSignature = 't=1234567890,v1=bad_signature_hash_0000000000000000000000000000000000000000000000000000';
  assert.throws(
    () => {
      stripeService.constructWebhookEvent(rawPayload, forgedSignature);
    },
    (err) => {
      assert.equal(err.type, 'StripeSignatureVerificationError');
      return true;
    },
    'Forged signature must throw signature verification error resulting in HTTP 400'
  );

  // Verify database was completely untouched
  assert.equal(webhookRepo.isProcessed('evt_forged_attempt_111'), false);
  const untouchedTenant = tenantRepo.getById(tenantId);
  assert.equal(untouchedTenant.current_plan_id, 'free');

  // 2. VALID SIGNED WEBHOOK & REPLAY DEDUPLICATION
  const validEventPayload = JSON.stringify({
    id: 'evt_legit_event_222',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_legit_session',
        customer: 'cus_test_123',
        subscription: 'sub_pro_222',
        metadata: { tenant_id: tenantId },
      },
    },
  });

  const validSignature = stripe.webhooks.generateTestHeaderString({
    payload: validEventPayload,
    secret: TEST_WEBHOOK_SECRET,
  });

  // Verify valid signature constructs event successfully
  const verifiedEvent = stripeService.constructWebhookEvent(validEventPayload, validSignature);
  assert.equal(verifiedEvent.id, 'evt_legit_event_222');

  // First execution: processed successfully
  const firstRun = webhookService.processEvent(verifiedEvent);
  assert.equal(firstRun.success, true);
  assert.equal(firstRun.duplicate, false);
  assert.equal(tenantRepo.getById(tenantId).current_plan_id, 'pro');

  // Second execution (Replay of the same event): DEDUPLICATED
  const replayRun = webhookService.processEvent(verifiedEvent);
  assert.equal(replayRun.success, true);
  assert.equal(replayRun.duplicate, true, 'Replay of the same event must be flagged as duplicate and ignored');
  assert.match(replayRun.message, /already been processed/);
});

test('Webhook - customer.subscription.deleted downgrades tenant back to Free', () => {
  const { tenantRepo, subRepo, webhookService } = setupStripeTestDb();
  const tenantId = 'tenant_stripe_1';

  // First set to Pro
  tenantRepo.updatePlan(tenantId, 'pro');

  const cancelEvent = {
    id: 'evt_sub_deleted_444',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_pro_to_cancel',
        customer: 'cus_test_123',
        metadata: { tenant_id: tenantId },
      },
    },
  };

  const cancelResult = webhookService.processEvent(cancelEvent);
  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.duplicate, false);

  // Verify downgraded to free
  const downgradedTenant = tenantRepo.getById(tenantId);
  assert.equal(downgradedTenant.current_plan_id, 'free');
});
