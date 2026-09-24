/**
 * Pricing constants pinned for deterministic cost calculation.
 * 
 * All money math uses INTEGERS (microcents):
 * 1 USD = 100 Cents
 * 1 Cent = 10,000 Microcents
 * 1 USD = 1,000,000 Microcents
 * 
 * Rates per 1,000,000 tokens:
 * - Fresh Input:     $0.150 per 1M = 150,000 microcents / 1M = 150 microcents / 1K tokens
 * - Cached Input:    $0.075 per 1M = 75,000 microcents / 1M = 75 microcents / 1K tokens (50% cheaper)
 * - Output:          $0.600 per 1M = 600,000 microcents / 1M = 600 microcents / 1K tokens
 * - Reasoning:       $0.600 per 1M = 600 microcents / 1K tokens (Strictly counts as Output tokens)
 * 
 * Base API calls:
 * - $1.00 per 10,000 API calls = 100 microcents per call
 */

const PRICING = {
  // Microcents conversion constants
  MICROCENTS_PER_CENT: 10000,
  MICROCENTS_PER_USD: 1000000,

  // Token rates in microcents per 1,000 tokens
  TOKENS: {
    FRESH_INPUT_PER_1K: 150,      // $0.15 per 1M tokens
    CACHED_INPUT_PER_1K: 75,      // $0.075 per 1M tokens (cached discount)
    OUTPUT_PER_1K: 600,           // $0.60 per 1M tokens
    REASONING_PER_1K: 600,        // Billed at output rate
  },

  // API Call rate in microcents per call
  API_CALL: {
    PER_CALL_MICROCENTS: 100,     // $0.00010 per call ($1.00 / 10,000 calls)
  },

  // Plan quotas & definitions
  PLANS: {
    free: {
      id: 'free',
      name: 'Free Tier',
      monthly_api_limit: 1000,
      monthly_token_limit: 100000,
      base_fee_microcents: 0,
      description: '1,000 API calls & 100k AI tokens per month',
    },
    pro: {
      id: 'pro',
      name: 'Pro Tier',
      monthly_api_limit: 50000,
      monthly_token_limit: 10000000,
      base_fee_microcents: 29000000, // $29.00 / month
      description: '50,000 API calls & 10,000,000 AI tokens per month',
    },
  },
};

/**
 * Format microcents to USD string (e.g. 125000 -> "$0.125000")
 */
function microcentsToUSD(microcents) {
  const dollars = microcents / PRICING.MICROCENTS_PER_USD;
  return `$${dollars.toFixed(6)}`;
}

/**
 * Format microcents to Cents float string (e.g. 125000 -> "12.50¢")
 */
function microcentsToCents(microcents) {
  const cents = microcents / PRICING.MICROCENTS_PER_CENT;
  return `${cents.toFixed(2)}¢`;
}

module.exports = {
  PRICING,
  microcentsToUSD,
  microcentsToCents,
};
