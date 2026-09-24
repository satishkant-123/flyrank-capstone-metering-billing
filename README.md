# Usage Metering & Billing Engine

[![Tests](https://img.shields.io/badge/tests-21%20passed-brightgreen.svg)](#testing)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)

A production-grade, multi-tenant **Usage Metering & Billing Engine** designed for AI and SaaS platforms. Built with strictly verified **idempotency**, **pre-operation quota enforcement** (429 / 402), **exact integer money math** (microcents), and **signature-verified Stripe subscription integration** (test mode).

---

## 1. What the System Does

1. **Exactly-Once Usage Metering:**  
   Every billable action is metered and attributed to a tenant. Retries with the same `Idempotency-Key` return the original response with zero double-counting.
2. **Boundary-Honest Quota Enforcement:**  
   Pre-checks monthly usage before allowing any billable action. When limits are exceeded, returns HTTP `429 Too Many Requests` with a `Retry-After` header. When subscriptions are unpaid or lapsed, returns HTTP `402 Payment Required`.
3. **Real-World AI Token Pricing Engine:**  
   Calculates costs using exact integer microcents ($1.00 = 1,000,000 microcents):
   - **Fresh Input Tokens:** \$0.150 per 1M tokens (150 microcents / 1k)
   - **Cached Input Tokens:** \$0.075 per 1M tokens (50% discount)
   - **Output Tokens:** \$0.600 per 1M tokens (600 microcents / 1k)
   - **Reasoning Tokens:** Strictly priced at output rates (\$0.600 / 1M)
4. **Stripe Test Mode Integration:**  
   Supports Stripe Checkout subscription flows (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`), with raw-buffer cryptographic signature verification and event deduplication.
5. **Usage Rollups & Invoicing:**  
   `GET /usage` returns live monthly aggregates, quota balances, token category breakdowns, and projected itemized invoices.
6. **Background Automation & Retries:**  
   Includes a nightly **Reconciliation Job** comparing database state against Stripe's subscription truth to heal dropped webhooks (featuring 3-attempt exponential backoff and persistent alerts logged in `job_failure_alerts`), and an **Alert Job** notifying when tenants cross 80% and 100% of their quota.

---

## 2. Subscription Plans & Quotas

| Plan | Monthly API Limit | Monthly AI Token Limit | Base Monthly Fee | Description |
|---|---|---|---|---|
| **Free** | 1,000 calls / mo | 100,000 tokens / mo | \$0.00 | Developer sandbox tier |
| **Pro** | 50,000 calls / mo | 10,000,000 tokens / mo | \$29.00 / mo | Production scaling tier |

---

## 3. Architecture & Data Flow

```
                                  Client Request
                                         │
                                         ▼
                 ┌──────────────────────────────────────────────┐
                 │          HTTP Layer (Express App)            │
                 │  - Boundary validation (clean 4xx, never 500)│
                 │  - Idempotency-Key extraction                │
                 │  - Raw-buffer HMAC Stripe webhook verify     │
                 └───────────────────────┬──────────────────────┘
                                         │
                         ┌───────────────┴───────────────┐
                         ▼                               ▼
               [ POST /generate ]                [ POST /webhooks/stripe ]
                         │                               │
                         ▼                               ▼
                 ┌──────────────┐                ┌──────────────┐
                 │ MeterService │                │WebhookService│
                 └───────┬──────┘                └───────┬──────┘
                         │                               │
         ┌───────────────┼───────────────┐               │
         ▼               ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ Idempotency │ │QuotaService │ │PricingEngine│ │ Webhook     │
  │ Cache Check │ │(429 vs 402) │ │(Microcents) │ │ Deduplicate │
  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
                         │                               │
                         ▼                               ▼
                 ┌──────────────────────────────────────────────┐
                 │       Persistence Layer (Repositories)       │
                 │       ACID SQLite with Foreign Keys & WAL    │
                 │   (8 Core Tables - schema details below)     │
                 └──────────────────────────────────────────────┘
```

### 3.1. Relational Database Tables

1. **`tenants`**: Isolated tenant accounts, plan tier, and Stripe customer mapping.
2. **`plans`**: Tier definitions (`free`, `pro`), monthly token/API limits, and base fees.
3. **`subscriptions`**: Billing cycle timestamps (`current_period_start`, `end`), Stripe subscription ID, and status (`active`, `past_due`, `canceled`).
4. **`usage_events`**: Immutable ledger of metered usage, token category breakdown, and integer microcents cost.
5. **`idempotency_keys`**: Request payload SHA-256 hash, cached response body, and status for replay deduplication.
6. **`processed_webhook_events`**: Cryptographic event IDs (`evt_...`) ensuring exactly-once webhook processing.
7. **`usage_alerts`**: Tracks dispatched quota threshold notifications (80% and 100%).
8. **`job_failure_alerts`**: Persistent audit record for background jobs after retry exhaustion (3 attempts), recording `job_name`, `error_message`, and `attempts`.

---

## 4. Setup & Quickstart

### Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0

### Step 1: Clone & Install Dependencies
```bash
git clone https://github.com/satishkant-123/flyrank-capstone-metering-billing.git
cd flyrank-capstone-metering-billing
npm install
```

### Step 2: Configure Environment
Copy the example environment file:
```bash
cp .env.example .env
```

### Step 3: Seed Database
Populates subscription plans and baseline demo tenants:
```bash
node src/db/seed.js
```

### Step 4: Start the Server
```bash
npm start
```
The server will boot on `http://localhost:3000`.

---

## 5. API Reference

### 5.1. Execute Billable Action
`POST /generate` (or `POST /api/v1/generate`)

**Headers:**
- `x-tenant-id`: `tenant_free_1` (Required)
- `idempotency-key`: `uuid-v4-string` (Optional, recommended)

**Request Body:**
```json
{
  "prompt": "Summarize this quarterly earnings call",
  "simulate_tokens": {
    "cached_input_tokens": 1000,
    "fresh_input_tokens": 2000,
    "output_tokens": 800,
    "reasoning_tokens": 200
  }
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "event_id": "evt_5602a220-a0fd-4f26-9299-d60c217793fb",
  "tenant_id": "tenant_free_1",
  "event_type": "ai_tokens",
  "quantity": 4000,
  "cost_microcents": 975,
  "cost_usd": "$0.000975",
  "cost_cents": "0.10¢",
  "breakdown": {
    "cached_input_tokens": 1000,
    "fresh_input_tokens": 2000,
    "output_tokens": 800,
    "reasoning_tokens": 200
  },
  "quota_balance": {
    "resource": "ai_tokens",
    "limit": 100000,
    "used": 4000,
    "remaining": 96000
  },
  "timestamp": "2026-09-24T14:19:59.589Z"
}
```

**Quota Exceeded Response (`429 Too Many Requests`):**
```json
{
  "error": "quota_exceeded",
  "message": "Monthly api_calls quota exceeded for plan 'Free Tier'. Limit: 1000, Used: 1000, Requested: 1.",
  "resource": "api_calls",
  "limit": 1000,
  "used": 1000,
  "requested": 1,
  "remaining": 0
}
```
*Response Header:* `Retry-After: 3600`

**Lapsed / Past Due Subscription (`402 Payment Required`):**
```json
{
  "error": "payment_required",
  "message": "Subscription for tenant 'tenant_past_due' is 'past_due'. An active payment method is required to proceed.",
  "subscription_status": "past_due"
}
```

---

### 5.2. Tenant Usage Rollup
`GET /usage?tenant_id=tenant_free_1` (or Header `x-tenant-id: tenant_free_1`)

**Response (`200 OK`):**
```json
{
  "tenant_id": "tenant_free_1",
  "tenant_name": "Acme Corp",
  "plan": { "id": "free", "name": "Free Tier", "status": "active" },
  "billing_period": {
    "start": "2026-09-01T00:00:00.000Z",
    "end": "2026-10-01T00:00:00.000Z"
  },
  "quotas": {
    "api_calls": { "used": 1, "limit": 1000, "remaining": 999, "percent_used": 0.1 },
    "ai_tokens": { "used": 4000, "limit": 100000, "remaining": 96000, "percent_used": 4.0 }
  },
  "token_breakdown": {
    "cached_input_tokens": 1000,
    "fresh_input_tokens": 2000,
    "output_tokens": 800,
    "reasoning_tokens": 200
  },
  "costs": {
    "base_plan_fee_microcents": 0,
    "base_plan_fee_usd": "$0.000000",
    "api_calls_microcents": 100,
    "api_calls_usd": "$0.000100",
    "ai_tokens_microcents": 975,
    "ai_tokens_usd": "$0.000975",
    "usage_total_microcents": 1075,
    "usage_total_usd": "$0.001075",
    "grand_total_microcents": 1075,
    "grand_total_usd": "$0.001075"
  }
}
```

---

### 5.3. Stripe Checkout & Webhooks
- **Create Checkout Session:** `POST /checkout/create-session`
- **Receive Stripe Webhooks:** `POST /webhooks/stripe`

To listen to Stripe events locally using Stripe CLI:
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

---

## 6. Testing & Probes

Run the full deterministic test suite in one command:
```bash
npm test
```

All 21 tests covering the 5 acceptance probes, unit pricing, boundary conditions, concurrency safety, and background job retries will execute:
```
✔ PROBE 1: Send the same billable request twice with one idempotency key -> exactly one usage event
✔ PROBE 2: Drive a tenant to its exact quota (999 -> 1000 -> 1001) with 429 response
✔ PROBE 3: Complete a Stripe test Checkout -> the webhook flips the tenant Free -> Pro
✔ PROBE 4: Send a forged webhook (bad signature) -> 400, replay real event -> processed once
✔ PROBE 5: Check pinned pricing rules -> cached & reasoning tokens produce exact totals
✔ Concurrency Safety - Prevents quota race condition when requests arrive simultaneously at boundary
✔ Validation at the boundary - bad input returns clean 4xx, never 500
✔ Background Job - Retry mechanism succeeds on retry attempt (Attempt 1 fail -> Attempt 2 success)
✔ Background Job - Retries exhausted (3 attempts) generates failure alert in job_failure_alerts
✔ Background Job - Usage alert triggers at 80% and 100% threshold
```

---

## 7. Limitations & Honest Scope Note

1. **Stripe Test Mode Only:**  
   The payment integration relies exclusively on Stripe Test Mode (`sk_test_...` and test card `4242 4242 4242 4242`). No real financial transactions or live credit cards are processed.
2. **Simulated AI Inference:**  
   The service measures and meters token numbers passed in requests (or estimated via character count); it does not call third-party OpenAI or Anthropic model endpoints directly.
3. **Single Currency:**  
   All cost calculations and ledger entries are denominated in USD (stored in integer microcents). Dynamic FX multi-currency conversion is not implemented.
4. **Single-Node SQLite:**  
   Persistence uses embedded SQLite (`node:sqlite`) with WAL mode and foreign key constraints, optimal for $0 setup and zero-dependency portability. For distributed horizontal scale across multiple server nodes, a connection pool to PostgreSQL is recommended.
