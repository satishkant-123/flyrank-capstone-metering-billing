const test = require('node:test');
const assert = require('node:assert/strict');
const PricingService = require('../../src/services/pricingService');
const { PRICING, microcentsToUSD, microcentsToCents } = require('../../src/config/pricing');

test('Pricing - Fresh input tokens priced at $0.150 per 1M (150 microcents / 1k)', () => {
  const result = PricingService.calculateTokenCost({
    fresh_input_tokens: 10000,
  });

  // 10,000 * 150 / 1000 = 1500 microcents = $0.001500
  assert.equal(result.cost_microcents, 1500);
  assert.equal(result.cost_usd, '$0.001500');
  assert.equal(result.fresh_cost_microcents, 1500);
  assert.equal(result.cached_cost_microcents, 0);
  assert.equal(result.output_cost_microcents, 0);
  assert.equal(result.reasoning_cost_microcents, 0);
});

test('Pricing - Cached input tokens are 50% cheaper ($0.075 per 1M = 75 microcents / 1k)', () => {
  const result = PricingService.calculateTokenCost({
    cached_input_tokens: 10000,
  });

  // 10,000 * 75 / 1000 = 750 microcents = $0.000750
  assert.equal(result.cost_microcents, 750);
  assert.equal(result.cost_usd, '$0.000750');
  assert.equal(result.cached_cost_microcents, 750);
  assert.equal(result.fresh_cost_microcents, 0);
});

test('Pricing - Reasoning tokens strictly count as output tokens ($0.600 per 1M = 600 microcents / 1k)', () => {
  const outputResult = PricingService.calculateTokenCost({
    output_tokens: 5000,
  });
  const reasoningResult = PricingService.calculateTokenCost({
    reasoning_tokens: 5000,
  });

  // Both should cost 5,000 * 600 / 1,000 = 3000 microcents = $0.003000
  assert.equal(outputResult.cost_microcents, 3000);
  assert.equal(reasoningResult.cost_microcents, 3000);
  assert.equal(outputResult.cost_usd, '$0.003000');
  assert.equal(reasoningResult.cost_usd, '$0.003000');
});

test('Pricing - Token categories cannot simply be added together (verifying distinct tiered pricing)', () => {
  // Scenario: 1,000 cached input, 2,000 fresh input, 1,000 output, 500 reasoning
  // Cached: 1,000 * 75 / 1000 = 75
  // Fresh:  2,000 * 150 / 1000 = 300
  // Output: 1,000 * 600 / 1000 = 600
  // Reasoning: 500 * 600 / 1000 = 300
  // Total expected = 75 + 300 + 600 + 300 = 1275 microcents ($0.001275)
  const result = PricingService.calculateTokenCost({
    cached_input_tokens: 1000,
    fresh_input_tokens: 2000,
    output_tokens: 1000,
    reasoning_tokens: 500,
  });

  assert.equal(result.total_tokens, 4500);
  assert.equal(result.cached_cost_microcents, 75);
  assert.equal(result.fresh_cost_microcents, 300);
  assert.equal(result.output_cost_microcents, 600);
  assert.equal(result.reasoning_cost_microcents, 300);
  assert.equal(result.cost_microcents, 1275);
  assert.equal(result.cost_usd, '$0.001275');

  // If someone naively summed all 4,500 tokens at fresh rate (4500 * 150 / 1000 = 675)
  // or at output rate (4500 * 600 / 1000 = 2700), it would be completely incorrect.
  assert.notEqual(result.cost_microcents, (4500 * 150) / 1000);
  assert.notEqual(result.cost_microcents, (4500 * 600) / 1000);
});

test('Pricing - API call rate ($1.00 / 10,000 calls = 100 microcents per call)', () => {
  const oneCall = PricingService.calculateApiCallCost(1);
  assert.equal(oneCall.cost_microcents, 100);
  assert.equal(oneCall.cost_usd, '$0.000100');

  const hundredCalls = PricingService.calculateApiCallCost(100);
  assert.equal(hundredCalls.cost_microcents, 10000); // 1 cent = 10,000 microcents
  assert.equal(hundredCalls.cost_usd, '$0.010000');
  assert.equal(hundredCalls.cost_cents, '1.00¢');
});
