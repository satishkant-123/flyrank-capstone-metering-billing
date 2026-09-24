# AI Assistance & Build Log (BUILDLOG.md)

**Project:** Usage Metering & Billing Engine  
**Intern / Author:** satishkant-123  
**Date:** September 2026  

---

## 1. Overview of AI-Assisted Development
This capstone was constructed using AI pair-programming with the DeepMind Antigravity agent. The AI assisted with system design drafting, database schema formulation, test suite generation, and boilerplate scaffolding. Every design decision, SQL query, mathematical formula, and error boundary was actively reviewed, tested, and verified against the Capstone Brief.

---

## 2. Where AI Helped
1. **Layered Architecture Scaffolding:**  
   AI rapidly established the 3-tier structure (HTTP routers/middleware $\rightarrow$ Domain services $\rightarrow$ Persistence repositories). This cleanly decoupled business logic like `PricingService` and `QuotaService` from Express HTTP concerns.
2. **Deterministic Test Vectors:**  
   AI quickly created realistic test suites (`node:test`) covering all 5 behavioral acceptance probes, including multi-token pricing edge cases (cached discounts, reasoning output equality).
3. **Idempotency Strategy Design:**  
   AI structured the composite key strategy (`tenant_id:idempotency_key`) and SHA-256 payload hashing to prevent replay attacks and payload mismatch conflicts (409 Conflict).

---

## 3. Where AI Was Wrong & What I Changed

### 3.1. The API Call Aggregation Bug (`COUNT` vs `SUM`)
- **What AI Initially Wrote:**  
  In `UsageEventRepository.getRollup()`, the AI drafted:
  ```sql
  COUNT(CASE WHEN event_type = 'api_call' THEN 1 END) as total_api_calls
  ```
- **Why It Failed:**  
  When testing boundary quotas with pre-seeded data, inserting an event with `quantity: 999` counted as `1` event rather than `999` API calls, causing boundary tests to fail.
- **What I Changed:**  
  Changed to:
  ```sql
  COALESCE(SUM(CASE WHEN event_type = 'api_call' THEN quantity ELSE 0 END), 0) as total_api_calls
  ```
  This correctly aggregates total calls regardless of whether requests arrive in single increments or batches.

### 3.2. Subscription Upsert Row Duplication & Ordering Drift
- **What AI Initially Wrote:**  
  The AI wrote `INSERT OR REPLACE INTO subscriptions` keyed on the subscription's internal ID (`id`).
- **Why It Failed:**  
  When a tenant transitioned from initial seed (`sub_free_init`) to Stripe Checkout (`sub_stripe_pro_live_123`), the primary key differed, creating two concurrent subscription rows for the same tenant. The subsequent query `ORDER BY updated_at DESC LIMIT 1` suffered from sub-second tie-breaking issues, intermittently returning the Free subscription instead of Pro.
- **What I Changed:**  
  Updated `SubscriptionRepository.upsert()` to first query `getByTenantId(subscription.tenant_id)` and execute an explicit `UPDATE ... WHERE rowid = ?` when an existing subscription exists for the tenant, ensuring single source of truth per tenant.

### 3.3. Webhook Raw Body Stream Consumption
- **What AI Initially Wrote:**  
  The AI initially placed `app.use(express.json())` at the top of the Express app pipeline before mounting the webhook router.
- **Why It Failed:**  
  Stripe's `stripe.webhooks.constructEvent()` requires the pristine raw Buffer. When `express.json()` parses the request first, HMAC signature calculation fails due to whitespace/formatting changes.
- **What I Changed:**  
  Reordered the middleware pipeline in `src/app.js` and mounted `express.raw({ type: 'application/json' })` strictly on `/webhooks/stripe` before the general JSON body parser.

### 3.4. Float Precision vs Integer Microcents
- **What AI Initially Proposed:**  
  Initial drafts included fractional cents using JavaScript `Number` floating point division.
- **Why It Was Inadequate:**  
  In billing engines, floating point arithmetic (`0.1 + 0.2 = 0.30000000000000004`) causes cumulative rounding leakage across millions of calls.
- **What I Changed:**  
  Established integer microcents ($1.00 = 1,000,000 microcents; 1 cent = 10,000 microcents) throughout the database schema and domain models, pinning token rates per 1,000 tokens with integer `Math.round()` calculations.

### 3.5. Concurrency Race Condition at Quota Boundaries
- **What AI Initially Wrote:**  
  Quota check was evaluated before opening the database transaction, allowing two concurrent requests at 999/1,000 to both pass the check before either committed.
- **What I Changed:**  
  Wrapped the entire check-and-insert sequence inside an atomic `BEGIN IMMEDIATE TRANSACTION;` in SQLite. This locks the write reservation immediately so simultaneous requests are strictly serialized, ensuring one request succeeds and the other receives HTTP 429.

### 3.6. Background Job Retries & Exponential Backoff
- **What AI Initially Wrote:**  
  The reconciliation job caught API exceptions and recorded an anomaly without retrying.
- **What I Changed:**  
  Implemented `executeWithRetry()` with 3 attempts and exponential backoff (`delay = baseDelay * 2^(attempt-1)`). Temporary network blips resolve on retry #2, avoiding false positive alerts.

### 3.7. Background Job Failure Alert Table
- **What AI Initially Wrote:**  
  Failed background jobs only printed to `console.error`.
- **What I Changed:**  
  Created the `job_failure_alerts` schema table and `JobAlertRepository` to record persistent job failures as structured database records when retries are exhausted.

---

## 4. Key Lines of Code & Explanations

1. **`src/services/meterService.js` (Lines 35–65):**  
   Opens `BEGIN IMMEDIATE TRANSACTION` to atomically evaluate idempotency and current quota balances before inserting billable records, completely preventing race conditions under concurrent load.
2. **`src/services/quotaService.js` (Lines 60–85):**  
   Pre-checks resource limits `currentUsage + requestedQty > limit`. If true, returns status `429 Too Many Requests` with `Retry-After: 3600` header before any billable work is metered.
3. **`src/jobs/reconciliationJob.js` (Lines 20–55):**  
   Executes Stripe reconciliation passes with 3 exponential backoff retries. If all retries fail, dispatches a persistent alert recorded into the `job_failure_alerts` table.
4. **`src/services/pricingService.js` (Lines 25–45):**  
   Encodes the AI token pricing rules: cached input tokens are billed at a 50% discount (75 microcents/1k), fresh input at 150 microcents/1k, output at 600 microcents/1k, and reasoning tokens strictly at 600 microcents/1k (output rate).
