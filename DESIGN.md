# System Design Document: LLM Usage Metering & Billing Engine

**Author:** FlyRank Backend Intern  
**Date:** September 2026  
**Status:** Approved & Implemented  
**Version:** 1.0.0  

---

## 1. Problem Statement & Mission
Every modern SaaS product, especially those providing AI and developer API services, must accurately answer three foundational questions:
1. **How much has this customer used?**
2. **How much should they pay?**
3. **Have they reached their plan limits?**

Under network retries, dropped connections, and asynchronous event delivery, naive billing implementations suffer from double-charging customers, granting unauthorized access, or miscalculating multi-tiered token costs. This service provides a fault-tolerant, resilient, and multi-tenant metering and billing engine built with strictly verified idempotency, atomic quota checks, exact integer money arithmetic, and Stripe subscription synchronization.

---

## 2. System Architecture & Layer Sketch

The system adheres strictly to a clean 3-tier layered architecture separating HTTP routing, domain business logic, and database persistence:

```
                  +--------------------------------------------------+
                  |                   HTTP Clients                   |
                  |     (Billable API, Dashboard, Stripe Webhook)    |
                  +--------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------+
| 1. HTTP Layer (Controllers & Middlewares)                                         |
|    - Request validation & schema sanitation (Zod/clean boundary checks)           |
|    - Idempotency-Key header extraction                                            |
|    - HTTP response formatting & error handling (clean 4xx, Retry-After, never 500) |
|    - Stripe cryptographic webhook signature verification (raw payload preserved)  |
+-----------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------+
| 2. Domain & Service Layer (Pure Business Logic)                                   |
|    - MeterService: Atomically verifies idempotency, checks quotas, records usage  |
|    - QuotaService: Evaluates plan limits (Free vs Pro) and enforces boundaries    |
|    - PricingEngine: Precision integer math (cached inputs, reasoning tokens)      |
|    - BillingService: Usage rollups, invoicing projections, alert threshold logic  |
|    - StripeWebhookService: Deduplicates webhook events & synchronizes tenant plan |
|    - ReconciliationJob: Background job verifying DB state against Stripe truth     |
+-----------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------+
| 3. Persistence Layer (Data Access & Repositories)                                 |
|    - TenantRepository, PlanRepository, SubscriptionRepository                     |
|    - UsageEventRepository, IdempotencyRepository, WebhookEventRepository         |
|    - Relational schema with foreign keys, compound indexes, and ACID transactions |
+-----------------------------------------------------------------------------------+
```

---

## 3. Data Model & Schema

All financial values are stored as integers (in **microcents**: 1 cent = 10,000 microcents; \$1.00 = 1,000,000 microcents) to completely eliminate floating-point rounding errors.

### Schema Definition:

1. **`plans`**
   - `id` (VARCHAR PK): e.g. `'free'`, `'pro'`
   - `name` (VARCHAR): Plan display name
   - `monthly_api_limit` (INTEGER): API call quota (Free: 1,000, Pro: 50,000)
   - `monthly_token_limit` (INTEGER): AI token quota (Free: 100,000, Pro: 10,000,000)
   - `base_fee_microcents` (INTEGER): Base monthly cost (Free: 0, Pro: 2,900,000 = \$29.00)
   - `created_at` (TIMESTAMP)

2. **`tenants`**
   - `id` (VARCHAR PK): e.g. `'tenant_abc123'`
   - `name` (VARCHAR): Tenant/Organization name
   - `email` (VARCHAR): Billing contact email
   - `current_plan_id` (VARCHAR FK -> `plans.id`): Active plan
   - `stripe_customer_id` (VARCHAR NULLABLE, INDEX): Stripe customer reference
   - `created_at` (TIMESTAMP)

3. **`subscriptions`**
   - `id` (VARCHAR PK): Internal or Stripe subscription ID (`sub_...`)
   - `tenant_id` (VARCHAR FK -> `tenants.id`, INDEX)
   - `plan_id` (VARCHAR FK -> `plans.id`)
   - `status` (VARCHAR): `'active'`, `'past_due'`, `'canceled'`, `'incomplete'`
   - `current_period_start` (TIMESTAMP): Start of billing cycle
   - `current_period_end` (TIMESTAMP): End of billing cycle
   - `updated_at` (TIMESTAMP)

4. **`usage_events`**
   - `id` (VARCHAR PK): UUID
   - `tenant_id` (VARCHAR FK -> `tenants.id`, INDEX)
   - `event_type` (VARCHAR): `'api_call'` or `'ai_tokens'`
   - `quantity` (INTEGER): Total count or tokens
   - `cached_input_tokens` (INTEGER DEFAULT 0)
   - `fresh_input_tokens` (INTEGER DEFAULT 0)
   - `output_tokens` (INTEGER DEFAULT 0)
   - `reasoning_tokens` (INTEGER DEFAULT 0)
   - `cost_microcents` (INTEGER): Calculated total cost for event in integer microcents
   - `idempotency_key` (VARCHAR NULLABLE, INDEX): Request idempotency identifier
   - `created_at` (TIMESTAMP, INDEX): Event timestamp

5. **`idempotency_keys`**
   - `key` (VARCHAR PK): Composite `tenant_id:idempotency_key`
   - `tenant_id` (VARCHAR FK -> `tenants.id`)
   - `request_hash` (VARCHAR): SHA-256 hash of payload to detect payload mismatch
   - `response_status` (INTEGER): Cached HTTP status code (e.g. 200)
   - `response_body` (TEXT): Serialized JSON response
   - `created_at` (TIMESTAMP)

6. **`processed_webhook_events`**
   - `event_id` (VARCHAR PK): Stripe Event ID (`evt_...`)
   - `event_type` (VARCHAR): e.g. `'checkout.session.completed'`
   - `processed_at` (TIMESTAMP)

---

## 4. API Surface & Contract Specifications

### 4.1. Billable API: Execute Billable Action & Usage Metering
- **Endpoint:** `POST /generate` (and `POST /api/v1/generate`)
- **Headers:** 
  - `x-tenant-id` (Required string)
  - `idempotency-key` (Optional but recommended string)
- **Request Body:**
  ```json
  {
    "prompt": "Explain quantum computing",
    "simulate_tokens": {
      "cached_input_tokens": 500,
      "fresh_input_tokens": 1500,
      "output_tokens": 800,
      "reasoning_tokens": 200
    }
  }
  ```
- **Responses:**
  - `200 OK`: Request allowed, metered, and answered.
    ```json
    {
      "success": true,
      "tenant_id": "tenant_1",
      "event_id": "ev_12345",
      "tokens_metered": 3000,
      "cost_microcents": 4450,
      "cost_usd": "$0.004450",
      "usage_balance": {
        "tokens_used": 15000,
        "tokens_limit": 100000,
        "api_calls_used": 24,
        "api_calls_limit": 1000
      }
    }
    ```
  - `429 Too Many Requests`: Tenant exceeded quota.
    - Headers: `Retry-After: 3600`
    - Body:
      ```json
      {
        "error": "quota_exceeded",
        "message": "Monthly AI token quota exceeded. Limit: 100000, Current: 98000, Requested: 3000",
        "resource": "ai_tokens",
        "limit": 100000,
        "used": 98000,
        "requested": 3000
      }
      ```
  - `402 Payment Required`: Tenant subscription is in an unpaid/lapsed status (`past_due`, `canceled`) or requires an upgrade.
    ```json
    {
      "error": "payment_required",
      "message": "Tenant subscription status is 'past_due'. Please update your payment method to resume access."
    }
    ```

### 4.2. Read Path: Tenant Usage Rollup
- **Endpoint:** `GET /usage` (Query `?tenant_id=tenant_1` or header `x-tenant-id`)
- **Response `200 OK`:**
  ```json
  {
    "tenant_id": "tenant_1",
    "plan": {
      "id": "free",
      "name": "Free Tier",
      "status": "active"
    },
    "billing_period": {
      "start": "2026-09-01T00:00:00.000Z",
      "end": "2026-10-01T00:00:00.000Z"
    },
    "quotas": {
      "api_calls": { "used": 24, "limit": 1000, "remaining": 976, "percent": 2.4 },
      "ai_tokens": { "used": 15000, "limit": 100000, "remaining": 85000, "percent": 15.0 }
    },
    "token_breakdown": {
      "cached_input_tokens": 2500,
      "fresh_input_tokens": 7500,
      "output_tokens": 4000,
      "reasoning_tokens": 1000
    },
    "costs": {
      "api_calls_microcents": 240,
      "ai_tokens_microcents": 22250,
      "base_fee_microcents": 0,
      "total_microcents": 22490,
      "total_usd": "$0.022490"
    }
  }
  ```

### 4.3. Stripe Integration: Checkout & Webhooks
- **Checkout Session:** `POST /checkout/create-session`
  - Body: `{ "tenant_id": "tenant_1", "success_url": "...", "cancel_url": "..." }`
  - Returns Stripe hosted checkout URL.
- **Webhook Endpoint:** `POST /webhooks/stripe`
  - Verifies cryptographic signature using `stripe.webhooks.constructEvent`.
  - Rejects forged payloads with `400 Bad Request`.
  - Checks `processed_webhook_events` to deduplicate replayed events.
  - Synchronizes tenant status for:
    - `checkout.session.completed` -> Upgrades tenant to `pro`
    - `customer.subscription.updated` -> Syncs status (`active`, `past_due`)
    - `customer.subscription.deleted` -> Reverts tenant to `free`

---

## 5. Token Pricing Rules & Exact Integer Money Math

AI Token costs depend strictly on the category of token:
- **Fresh Input Tokens:** \$0.150 per 1M tokens = 150 microcents / 1,000 tokens
- **Cached Input Tokens (Cheaper):** \$0.075 per 1M tokens (50% discount) = 75 microcents / 1,000 tokens
- **Output Tokens:** \$0.600 per 1M tokens = 600 microcents / 1,000 tokens
- **Reasoning Tokens:** Billed as **Output Tokens** (\$0.600 per 1M tokens), never free or added to input
- **Base API Calls:** \$1.00 per 10,000 calls = 10 microcents per call

### Mathematical Formulation:
$$\text{Cost}_{\text{microcents}} = \lfloor \frac{\text{cached} \times 75 + \text{fresh} \times 150 + (\text{output} + \text{reasoning}) \times 600}{1000} \rfloor$$

Using integer arithmetic prevents cumulative float discrepancies across millions of transactions.

---

## 6. Idempotency Strategy
1. Client generates and sends `Idempotency-Key` (e.g. UUIDv4).
2. Inside an ACID transaction:
   - Check if `(tenant_id, key)` exists in `idempotency_keys`.
   - If found:
     - Verify `request_hash`. If body differs, return `409 Conflict`.
     - Return cached status and cached response immediately without creating a new usage event.
   - If not found:
     - Perform quota check. If exceeded, return `429` (and do not record usage).
     - If permitted, insert record into `usage_events`.
     - Store resulting response in `idempotency_keys`.
     - Commit transaction.

---

## 7. Quota Enforcement & Boundary Semantics
- **Boundary Policy:** Quotas are **pre-enforced** before the billable operation executes.
- If current usage is 999 of 1,000 API calls:
  - An API call requesting 1 call will be **allowed** (bringing total to 1,000).
  - The subsequent API call will be **rejected with 429**.
- If token usage is 99,500 of 100,000 and a request requires 600 tokens:
  - Request is **rejected with 429** before consuming resources because `99,500 + 600 > 100,000`.
- **402 Payment Required** is returned when a customer's subscription has lapsed, is past due, or requires an immediate upgrade rather than simple rate throttle.

---

## 8. Explicit Non-Goals
1. **No External Model Invocations:** AI token metrics are simulated via request parameters or measured directly from input payload length; no external API key is needed.
2. **No Real Credit Card Processing:** All payments run through Stripe Test Mode (`sk_test_...` and test card `4242 4242 4242 4242`).
3. **No Multi-Currency FX Rates:** All billing is evaluated in USD and stored in microcents.
