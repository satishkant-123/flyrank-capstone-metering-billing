-- FlyRank Metering & Billing Engine Schema
-- All monetary figures stored as INTEGER microcents ($1.00 = 1,000,000 microcents)

PRAGMA foreign_keys = ON;

-- 1. Subscription Plans
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_api_limit INTEGER NOT NULL,
  monthly_token_limit INTEGER NOT NULL,
  base_fee_microcents INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Multi-tenant Accounts
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  current_plan_id TEXT NOT NULL REFERENCES plans(id),
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Subscriptions (Mirrors Stripe state)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL, -- 'active', 'past_due', 'canceled', 'incomplete'
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Usage Events (Append-only billable events)
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_type TEXT NOT NULL, -- 'api_call', 'ai_tokens'
  quantity INTEGER NOT NULL,
  cached_input_tokens INTEGER DEFAULT 0,
  fresh_input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cost_microcents INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Idempotency Keys (Exact duplicate prevention & response caching)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, -- Scoped key: "tenant_id:idempotency_key"
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 6. Processed Webhook Events (Deduplicate Stripe webhook retries)
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Quota Alert Logs (Track notification boundaries 80%, 100%)
CREATE TABLE IF NOT EXISTS usage_alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  resource TEXT NOT NULL, -- 'api_calls', 'ai_tokens'
  threshold_percent INTEGER NOT NULL, -- 80 or 100
  period TEXT NOT NULL, -- 'YYYY-MM'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, resource, threshold_percent, period)
);

-- Indexes for performance & isolation
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created ON usage_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_idempotency ON usage_events (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_stripe_cust ON tenants (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant ON idempotency_keys (tenant_id);
