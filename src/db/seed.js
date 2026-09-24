const { getDatabase, runMigrations } = require('./connection');
const { PRICING } = require('../config/pricing');

function seedDatabase(db = getDatabase()) {
  runMigrations(db);

  // 1. Seed Plans
  const insertPlan = db.prepare(`
    INSERT OR REPLACE INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertPlan.run(
    PRICING.PLANS.free.id,
    PRICING.PLANS.free.name,
    PRICING.PLANS.free.monthly_api_limit,
    PRICING.PLANS.free.monthly_token_limit,
    PRICING.PLANS.free.base_fee_microcents,
    PRICING.PLANS.free.description
  );

  insertPlan.run(
    PRICING.PLANS.pro.id,
    PRICING.PLANS.pro.name,
    PRICING.PLANS.pro.monthly_api_limit,
    PRICING.PLANS.pro.monthly_token_limit,
    PRICING.PLANS.pro.base_fee_microcents,
    PRICING.PLANS.pro.description
  );

  // Current billing period (current month)
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  // 2. Seed Tenants & Subscriptions
  const insertTenant = db.prepare(`
    INSERT OR REPLACE INTO tenants (id, name, email, current_plan_id, stripe_customer_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertSubscription = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Demo Tenant 1: Fresh Free tier tenant
  insertTenant.run('tenant_free_1', 'Acme Corp', 'billing@acme.test', 'free', 'cus_test_free_1');
  insertSubscription.run('sub_test_free_1', 'tenant_free_1', 'free', 'active', startOfMonth, endOfMonth, 'cus_test_free_1', null);

  // Demo Tenant 2: Pro tier tenant
  insertTenant.run('tenant_pro_1', 'Omni Global', 'billing@omni.test', 'pro', 'cus_test_pro_1');
  insertSubscription.run('sub_test_pro_1', 'tenant_pro_1', 'pro', 'active', startOfMonth, endOfMonth, 'cus_test_pro_1', 'sub_stripe_pro_1');

  // Demo Tenant 3: Boundary Test tenant (will be at 999 calls)
  insertTenant.run('tenant_boundary_test', 'Boundary Labs', 'boundary@test.test', 'free', 'cus_test_boundary');
  insertSubscription.run('sub_test_boundary', 'tenant_boundary_test', 'free', 'active', startOfMonth, endOfMonth, 'cus_test_boundary', null);

  // Demo Tenant 4: Past Due tenant (for 402 Payment Required testing)
  insertTenant.run('tenant_past_due', 'Lapsed Co', 'finance@lapsed.test', 'pro', 'cus_test_past_due');
  insertSubscription.run('sub_test_past_due', 'tenant_past_due', 'pro', 'past_due', startOfMonth, endOfMonth, 'cus_test_past_due', 'sub_stripe_past_due');

  console.log('Database seeded successfully with plans and initial demo tenants.');
}

if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };
