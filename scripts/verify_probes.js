const http = require('node:http');
const createApp = require('../src/app');
const { getDatabase, runMigrations } = require('../src/db/connection');
const { seedDatabase } = require('../src/db/seed');
const Stripe = require('stripe');
const config = require('../src/config/env');

const stripe = new Stripe('sk_test_mock_key', { apiVersion: '2023-10-16' });

async function run() {
  const db = getDatabase(':memory:');
  runMigrations(db);
  seedDatabase(db);

  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`=== Verification Server Started on ${baseUrl} ===\n`);

  // Helper fetch function
  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, options);
    let body;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
  }

  // PROBE 1: Send the same billable request twice with one idempotency key
  console.log('--- PROBE 1: Idempotency & Duplicate Prevention ---');
  const payload1 = {
    prompt: 'Summarize annual report',
    simulate_tokens: {
      cached_input_tokens: 1000,
      fresh_input_tokens: 2000,
      output_tokens: 800,
      reasoning_tokens: 200,
    },
  };
  const key1 = 'probe1-idem-uuid-999';

  const r1_first = await request('/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant_free_1',
      'idempotency-key': key1,
    },
    body: JSON.stringify(payload1),
  });
  console.log('Call 1 Status:', r1_first.status);
  console.log('Call 1 Body:', JSON.stringify(r1_first.body, null, 2));

  const r1_second = await request('/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant_free_1',
      'idempotency-key': key1,
    },
    body: JSON.stringify(payload1),
  });
  console.log('Call 2 Status:', r1_second.status);
  console.log('Call 2 Idempotent-Replay Header:', r1_second.headers['idempotent-replay']);
  console.log('Call 2 Body:', JSON.stringify(r1_second.body, null, 2));
  console.log('Identical Bodies:', JSON.stringify(r1_first.body) === JSON.stringify(r1_second.body));

  // PROBE 2: Quota boundary (999 -> 1000 -> 1001)
  console.log('\n--- PROBE 2: Quota Boundary Honesty (429 & 402) ---');
  // Seed tenant_boundary_test with 999 calls
  db.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
    VALUES ('evt_pre_999', 'tenant_boundary_test', 'api_call', 999, 99900, datetime('now'))
  `).run();

  const r2_call1000 = await request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_boundary_test' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });
  console.log('Boundary Call 1,000 Status:', r2_call1000.status);
  console.log('Boundary Call 1,000 Body:', JSON.stringify(r2_call1000.body, null, 2));

  const r2_call1001 = await request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_boundary_test' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });
  console.log('Exceeded Call 1,001 Status:', r2_call1001.status);
  console.log('Exceeded Call 1,001 Retry-After:', r2_call1001.headers['retry-after']);
  console.log('Exceeded Call 1,001 Body:', JSON.stringify(r2_call1001.body, null, 2));

  // 402 Payment Required for past_due tenant
  const r2_pastDue = await request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_past_due' },
    body: JSON.stringify({ event_type: 'api_call', api_call_count: 1 }),
  });
  console.log('Lapsed Subscription Status:', r2_pastDue.status);
  console.log('Lapsed Subscription Body:', JSON.stringify(r2_pastDue.body, null, 2));

  // PROBE 3: Stripe Checkout webhook flips Free -> Pro
  console.log('\n--- PROBE 3: Stripe Checkout Webhook (Free -> Pro) ---');
  const usageBefore = await request('/usage?tenant_id=tenant_free_1');
  console.log('Plan Before Webhook:', usageBefore.body.plan.name, 'Limits:', usageBefore.body.quotas);

  const checkoutWebhookPayload = JSON.stringify({
    id: 'evt_stripe_checkout_success_777',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_session_777',
        customer: 'cus_test_free_1',
        subscription: 'sub_test_stripe_pro_777',
        client_reference_id: 'tenant_free_1',
        metadata: { tenant_id: 'tenant_free_1' },
      },
    },
  });

  const validSig = stripe.webhooks.generateTestHeaderString({
    payload: checkoutWebhookPayload,
    secret: config.stripe.webhookSecret,
  });

  const webhookRes = await request('/webhooks/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': validSig,
    },
    body: checkoutWebhookPayload,
  });
  console.log('Webhook Response:', webhookRes.status, webhookRes.body);

  const usageAfter = await request('/usage?tenant_id=tenant_free_1');
  console.log('Plan After Webhook:', usageAfter.body.plan.name, 'Limits:', usageAfter.body.quotas);

  // PROBE 4: Forged webhook signature & duplicate replay
  console.log('\n--- PROBE 4: Forged Webhook & Event Replay ---');
  const forgedRes = await request('/webhooks/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=12345,v1=forged_bad_signature_hash',
    },
    body: checkoutWebhookPayload,
  });
  console.log('Forged Webhook Status:', forgedRes.status, forgedRes.body);

  const replayRes = await request('/webhooks/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': validSig,
    },
    body: checkoutWebhookPayload,
  });
  console.log('Replay Webhook Status:', replayRes.status, replayRes.body);

  // PROBE 5: Pinned Pricing Rules Verification
  console.log('\n--- PROBE 5: Pinned Pricing Rules Rollup ---');
  const probe5Res = await request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_pro_1' },
    body: JSON.stringify({
      simulate_tokens: {
        cached_input_tokens: 2000, // 2000 * 75 / 1000 = 150
        fresh_input_tokens: 4000,  // 4000 * 150 / 1000 = 600
        output_tokens: 1000,       // 1000 * 600 / 1000 = 600
        reasoning_tokens: 500,     // 500 * 600 / 1000 = 300
      },
    }),
  });
  console.log('Billable Event 5 Body:', JSON.stringify(probe5Res.body, null, 2));

  const usagePro = await request('/usage?tenant_id=tenant_pro_1');
  console.log('Rollup /usage Body:', JSON.stringify(usagePro.body, null, 2));

  server.close();
  console.log('\n=== All Acceptance Probes Successfully Executed ===');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
