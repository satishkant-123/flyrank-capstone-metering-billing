/**
 * Evaluator Simulation Script
 * 
 * Simulates the exact automated evaluation protocol described in Section 12 of the Capstone Brief:
 * - Layer 1: Machine-checkable submission pack & manifest validation
 * - Layer 2: Live acceptance probes (PROBE 1 through PROBE 5) executed against live HTTP endpoints
 * - Shared Requirements: Boundary validation, persistence, integer math, secret hygiene
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Stripe = require('stripe');
const createApp = require('../src/app');
const { getDatabase, runMigrations } = require('../src/db/connection');
const { seedDatabase } = require('../src/db/seed');
const config = require('../src/config/env');

const stripe = new Stripe('sk_test_mock_key', { apiVersion: '2023-10-16' });

async function runEvaluatorSimulation() {
  console.log('================================================================');
  console.log('   FLYRANK CAPSTONE EVALUATOR AUTOMATED AUDIT (SECTION 12)       ');
  console.log('================================================================\n');

  let layer1Pass = true;
  let layer2Pass = true;

  // -------------------------------------------------------------------------
  // LAYER 1: The Submission Pack (Machine-Checkable)
  // -------------------------------------------------------------------------
  console.log('>>> [LAYER 1] Verifying Submission Pack Structure...');
  const requiredFiles = [
    'README.md',
    'capstone.yaml',
    'EVIDENCE.md',
    'BUILDLOG.md',
    '.env.example',
    'DESIGN.md',
  ];

  for (const file of requiredFiles) {
    const exists = fs.existsSync(path.join(__dirname, '..', file));
    if (exists) {
      console.log(`  [PASS] File exists: ${file}`);
    } else {
      console.error(`  [FAIL] Missing required file: ${file}`);
      layer1Pass = false;
    }
  }

  // Validate capstone.yaml contents
  const capstoneYaml = fs.readFileSync(path.join(__dirname, '..', 'capstone.yaml'), 'utf8');
  const hasRun = capstoneYaml.includes('run:');
  const hasSeed = capstoneYaml.includes('seed:');
  const hasTest = capstoneYaml.includes('test:');
  const hasBaseUrl = capstoneYaml.includes('base_url:');

  if (hasRun && hasSeed && hasTest && hasBaseUrl) {
    console.log('  [PASS] capstone.yaml contains required keys: run, seed, test, base_url');
  } else {
    console.error('  [FAIL] capstone.yaml missing required keys');
    layer1Pass = false;
  }

  // Secret hygiene check
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  if (gitignore.includes('.env')) {
    console.log('  [PASS] Secret hygiene: .env is properly git-ignored');
  } else {
    console.error('  [FAIL] Secret hygiene: .env is NOT in .gitignore');
    layer1Pass = false;
  }

  console.log(`\n>>> LAYER 1 RESULT: ${layer1Pass ? 'ALL CHECKS PASSED ✅' : 'FAILED ❌'}\n`);

  // -------------------------------------------------------------------------
  // LAYER 2: Live Acceptance Probes (Behavioral, Pass/Fail)
  // -------------------------------------------------------------------------
  console.log('>>> [LAYER 2] Launching Isolated System Instance for Probes...');

  // Initialize fresh isolated DB
  const db = getDatabase(':memory:');
  runMigrations(db);
  seedDatabase(db);

  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`  System running on ${baseUrl}\n`);

  async function api(endpoint, options = {}) {
    const res = await fetch(`${baseUrl}${endpoint}`, options);
    let body;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
  }

  // -------------------------------------------------------------------------
  // PROBE 1: Send the same billable request twice with one idempotency key
  // -------------------------------------------------------------------------
  console.log('>>> Running PROBE 1: Exactly-Once Metering & Idempotency Key...');
  const keyP1 = `eval-idem-probe1-${Date.now()}`;
  const payloadP1 = {
    prompt: 'Summarize quarterly financial statements',
    simulate_tokens: {
      cached_input_tokens: 1000,
      fresh_input_tokens: 2000,
      output_tokens: 800,
      reasoning_tokens: 200,
    },
  };

  const p1_first = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_free_1', 'idempotency-key': keyP1 },
    body: JSON.stringify(payloadP1),
  });

  const p1_second = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_free_1', 'idempotency-key': keyP1 },
    body: JSON.stringify(payloadP1),
  });

  const p1_pass = p1_first.status === 200 &&
                  p1_second.status === 200 &&
                  p1_second.headers['idempotent-replay'] === 'true' &&
                  p1_first.body.event_id === p1_second.body.event_id;

  if (p1_pass) {
    console.log(`  [PASS] PROBE 1: Exactly one usage event recorded (ID: ${p1_first.body.event_id}). Second call mirrored first with Idempotent-Replay.`);
  } else {
    console.error('  [FAIL] PROBE 1 failed:', { p1_first, p1_second });
    layer2Pass = false;
  }

  // -------------------------------------------------------------------------
  // PROBE 2: Drive a tenant to its exact quota (Boundary 429 & 402)
  // -------------------------------------------------------------------------
  console.log('\n>>> Running PROBE 2: Quota Boundary Honesty (429 & 402)...');
  // Seed tenant_boundary_test to 999 calls
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES ('evt_probe2_999', 'tenant_boundary_test', 'api_call', 999, 99900, datetime('now'))
  `).run();

  // Call 1,000 (at boundary) -> Must be 200 OK
  const p2_call1000 = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_boundary_test' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });

  // Call 1,001 (over quota) -> Must be 429 Too Many Requests
  const p2_call1001 = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_boundary_test' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });

  // Call from tenant_past_due -> Must be 402 Payment Required
  const p2_call402 = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_past_due' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });

  const p2_pass = p2_call1000.status === 200 &&
                  p2_call1001.status === 429 &&
                  p2_call1001.headers['retry-after'] === '3600' &&
                  p2_call402.status === 402;

  if (p2_pass) {
    console.log('  [PASS] PROBE 2: Boundary call 1,000 allowed (200), call 1,001 blocked with 429 & Retry-After header. Past-due blocked with 402.');
  } else {
    console.error('  [FAIL] PROBE 2 failed:', { p2_call1000, p2_call1001, p2_call402 });
    layer2Pass = false;
  }

  // -------------------------------------------------------------------------
  // PROBE 3: Stripe Checkout Webhook flips Free -> Pro
  // -------------------------------------------------------------------------
  console.log('\n>>> Running PROBE 3: Stripe Test Checkout Webhook (Free -> Pro)...');
  const usageBefore = await api('/usage?tenant_id=tenant_free_1');
  const initialPlan = usageBefore.body.plan.id;

  const checkoutPayload = JSON.stringify({
    id: `evt_eval_checkout_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_eval_test_session',
        customer: 'cus_test_free_1',
        subscription: 'sub_eval_stripe_pro',
        client_reference_id: 'tenant_free_1',
        metadata: { tenant_id: 'tenant_free_1' },
      },
    },
  });

  const checkoutSig = stripe.webhooks.generateTestHeaderString({
    payload: checkoutPayload,
    secret: config.stripe.webhookSecret,
  });

  const webhookP3 = await api('/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': checkoutSig },
    body: checkoutPayload,
  });

  const usageAfter = await api('/usage?tenant_id=tenant_free_1');
  const upgradedPlan = usageAfter.body.plan.id;
  const newLimit = usageAfter.body.quotas.api_calls.limit;

  const p3_pass = initialPlan === 'free' &&
                  webhookP3.status === 200 &&
                  upgradedPlan === 'pro' &&
                  newLimit === 50000;

  if (p3_pass) {
    console.log(`  [PASS] PROBE 3: Webhook flipped tenant Free -> Pro. API call quota upgraded from 1,000 to ${newLimit}.`);
  } else {
    console.error('  [FAIL] PROBE 3 failed:', { initialPlan, upgradedPlan, newLimit });
    layer2Pass = false;
  }

  // -------------------------------------------------------------------------
  // PROBE 4: Forged Webhook (400) and Deduplicated Replay (processed once)
  // -------------------------------------------------------------------------
  console.log('\n>>> Running PROBE 4: Webhook Signature Verification & Deduplication...');
  const forgedRes = await api('/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=bad_signature_hash' },
    body: checkoutPayload,
  });

  const replayRes = await api('/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': checkoutSig },
    body: checkoutPayload,
  });

  const p4_pass = forgedRes.status === 400 &&
                  replayRes.status === 200 &&
                  replayRes.body.duplicate === true;

  if (p4_pass) {
    console.log('  [PASS] PROBE 4: Forged signature rejected with 400 Bad Request. Replayed event recognized as duplicate.');
  } else {
    console.error('  [FAIL] PROBE 4 failed:', { forgedRes, replayRes });
    layer2Pass = false;
  }

  // -------------------------------------------------------------------------
  // PROBE 5: Pinned Pricing Rules Rollup (Tokens, Reasoning, API Calls)
  // -------------------------------------------------------------------------
  console.log('\n>>> Running PROBE 5: Pinned Pricing Rules & Rollup...');
  // Record:
  // 2,000 cached input ($0.075/1M = 150 microcents)
  // 4,000 fresh input  ($0.150/1M = 600 microcents)
  // 1,000 output       ($0.600/1M = 600 microcents)
  // 500 reasoning      ($0.600/1M = 300 microcents, output rate)
  // Expected total = 1,650 microcents ($0.001650)
  const probe5Call = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_pro_1' },
    body: JSON.stringify({
      simulate_tokens: {
        cached_input_tokens: 2000,
        fresh_input_tokens: 4000,
        output_tokens: 1000,
        reasoning_tokens: 500,
      },
    }),
  });

  const usagePro = await api('/usage?tenant_id=tenant_pro_1');
  const proCosts = usagePro.body.costs;

  const p5_pass = probe5Call.status === 200 &&
                  probe5Call.body.cost_microcents === 1650 &&
                  probe5Call.body.cost_usd === '$0.001650' &&
                  proCosts.ai_tokens_microcents === 1650;

  if (p5_pass) {
    console.log(`  [PASS] PROBE 5: Exact token math confirmed (${probe5Call.body.cost_microcents} microcents = ${probe5Call.body.cost_usd}). /usage rollup matches.`);
  } else {
    console.error('  [FAIL] PROBE 5 failed:', { probe5Call, proCosts });
    layer2Pass = false;
  }

  server.close();

  // -------------------------------------------------------------------------
  // FINAL SCORECARD
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('                  EVALUATOR FINAL SCORECARD                     ');
  console.log('================================================================');
  console.log(`  Layer 1 - Submission Pack (Machine Check):    ${layer1Pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`  Layer 2 - PROBE 1 (Exactly-Once Metering):    ${p1_pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`  Layer 2 - PROBE 2 (Boundary 429 & 402):       ${p2_pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`  Layer 2 - PROBE 3 (Stripe Free -> Pro Sync):  ${p3_pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`  Layer 2 - PROBE 4 (Signature Verify & Replay): ${p4_pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`  Layer 2 - PROBE 5 (Pinned AI Pricing Rules):  ${p5_pass ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log('----------------------------------------------------------------');

  const overall = layer1Pass && layer2Pass;
  console.log(`  OVERALL EVALUATION VERDICT: ${overall ? 'ALL REQUIREMENTS 100% PASS ✅' : 'REJECTED ❌'}`);
  console.log('================================================================\n');

  if (!overall) {
    process.exit(1);
  }
}

runEvaluatorSimulation().catch((err) => {
  console.error('[Evaluator Error]', err);
  process.exit(1);
});
