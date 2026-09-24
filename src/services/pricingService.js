const { PRICING, microcentsToUSD, microcentsToCents } = require('../config/pricing');

class PricingService {
  /**
   * Calculate cost for AI tokens strictly using integer arithmetic.
   * Rules:
   * 1. Cached input tokens are cheaper ($0.075 / 1M = 75 microcents / 1k).
   * 2. Fresh input tokens: $0.150 / 1M = 150 microcents / 1k.
   * 3. Output tokens: $0.600 / 1M = 600 microcents / 1k.
   * 4. Reasoning tokens count as output tokens (billed at $0.600 / 1M = 600 microcents / 1k).
   * 5. Categories cannot simply be added together!
   * 
   * Returns integer microcents.
   */
  static calculateTokenCost({
    cached_input_tokens = 0,
    fresh_input_tokens = 0,
    output_tokens = 0,
    reasoning_tokens = 0,
  }) {
    const cached = Math.max(0, parseInt(cached_input_tokens || 0, 10));
    const fresh = Math.max(0, parseInt(fresh_input_tokens || 0, 10));
    const output = Math.max(0, parseInt(output_tokens || 0, 10));
    const reasoning = Math.max(0, parseInt(reasoning_tokens || 0, 10));

    // Integer microcents calculation
    // rate per 1,000 tokens multiplied by token count, divided by 1,000
    const cachedCostMicrocents = Math.round((cached * PRICING.TOKENS.CACHED_INPUT_PER_1K) / 1000);
    const freshCostMicrocents = Math.round((fresh * PRICING.TOKENS.FRESH_INPUT_PER_1K) / 1000);
    const outputCostMicrocents = Math.round((output * PRICING.TOKENS.OUTPUT_PER_1K) / 1000);
    const reasoningCostMicrocents = Math.round((reasoning * PRICING.TOKENS.REASONING_PER_1K) / 1000);

    const totalMicrocents = cachedCostMicrocents + freshCostMicrocents + outputCostMicrocents + reasoningCostMicrocents;

    return {
      total_tokens: cached + fresh + output + reasoning,
      cached_input_tokens: cached,
      fresh_input_tokens: fresh,
      output_tokens: output,
      reasoning_tokens: reasoning,
      cached_cost_microcents: cachedCostMicrocents,
      fresh_cost_microcents: freshCostMicrocents,
      output_cost_microcents: outputCostMicrocents,
      reasoning_cost_microcents: reasoningCostMicrocents,
      cost_microcents: totalMicrocents,
      cost_usd: microcentsToUSD(totalMicrocents),
      cost_cents: microcentsToCents(totalMicrocents),
    };
  }

  /**
   * Calculate cost for API calls strictly using integer arithmetic.
   */
  static calculateApiCallCost(callCount = 1) {
    const calls = Math.max(0, parseInt(callCount, 10));
    const totalMicrocents = calls * PRICING.API_CALL.PER_CALL_MICROCENTS;

    return {
      api_calls: calls,
      cost_microcents: totalMicrocents,
      cost_usd: microcentsToUSD(totalMicrocents),
      cost_cents: microcentsToCents(totalMicrocents),
    };
  }
}

module.exports = PricingService;
