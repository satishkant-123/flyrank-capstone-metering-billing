const TenantRepository = require('../repositories/tenantRepository');
const PlanRepository = require('../repositories/planRepository');
const SubscriptionRepository = require('../repositories/subscriptionRepository');
const UsageEventRepository = require('../repositories/usageEventRepository');
const { PRICING, microcentsToUSD, microcentsToCents } = require('../config/pricing');

class BillingService {
  constructor(deps = {}) {
    this.tenantRepo = deps.tenantRepo || new TenantRepository();
    this.planRepo = deps.planRepo || new PlanRepository();
    this.subRepo = deps.subRepo || new SubscriptionRepository();
    this.usageRepo = deps.usageRepo || new UsageEventRepository();
  }

  getCurrentBillingPeriod(subscription) {
    if (subscription && subscription.current_period_start && subscription.current_period_end) {
      return {
        start: subscription.current_period_start,
        end: subscription.current_period_end,
      };
    }

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    return { start, end };
  }

  getTenantUsageRollup(tenantId) {
    const tenant = this.tenantRepo.getById(tenantId);
    if (!tenant) {
      return { error: 'tenant_not_found', statusCode: 404, message: `Tenant '${tenantId}' not found.` };
    }

    const plan = this.planRepo.getById(tenant.current_plan_id);
    const subscription = this.subRepo.getByTenantId(tenantId);
    const period = this.getCurrentBillingPeriod(subscription);

    const rollup = this.usageRepo.getRollup(tenantId, period.start, period.end);

    const apiCallsUsed = rollup.total_api_calls;
    const tokensUsed = rollup.total_tokens;

    const apiCallsRemaining = Math.max(0, plan.monthly_api_limit - apiCallsUsed);
    const tokensRemaining = Math.max(0, plan.monthly_token_limit - tokensUsed);

    const apiCallsPercent = plan.monthly_api_limit > 0
      ? Number(((apiCallsUsed / plan.monthly_api_limit) * 100).toFixed(2))
      : 0;

    const tokensPercent = plan.monthly_token_limit > 0
      ? Number(((tokensUsed / plan.monthly_token_limit) * 100).toFixed(2))
      : 0;

    const totalUsageCostMicrocents = rollup.total_cost_microcents;
    const baseFeeMicrocents = plan.base_fee_microcents || 0;
    const grandTotalMicrocents = totalUsageCostMicrocents + baseFeeMicrocents;

    return {
      statusCode: 200,
      data: {
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        plan: {
          id: plan.id,
          name: plan.name,
          status: subscription ? subscription.status : 'active',
        },
        billing_period: {
          start: period.start,
          end: period.end,
        },
        quotas: {
          api_calls: {
            used: apiCallsUsed,
            limit: plan.monthly_api_limit,
            remaining: apiCallsRemaining,
            percent_used: apiCallsPercent,
          },
          ai_tokens: {
            used: tokensUsed,
            limit: plan.monthly_token_limit,
            remaining: tokensRemaining,
            percent_used: tokensPercent,
          },
        },
        token_breakdown: {
          cached_input_tokens: rollup.cached_input_tokens,
          fresh_input_tokens: rollup.fresh_input_tokens,
          output_tokens: rollup.output_tokens,
          reasoning_tokens: rollup.reasoning_tokens,
        },
        costs: {
          base_plan_fee_microcents: baseFeeMicrocents,
          base_plan_fee_usd: microcentsToUSD(baseFeeMicrocents),
          api_calls_microcents: rollup.api_call_cost_microcents,
          api_calls_usd: microcentsToUSD(rollup.api_call_cost_microcents),
          ai_tokens_microcents: rollup.tokens_cost_microcents,
          ai_tokens_usd: microcentsToUSD(rollup.tokens_cost_microcents),
          usage_total_microcents: totalUsageCostMicrocents,
          usage_total_usd: microcentsToUSD(totalUsageCostMicrocents),
          grand_total_microcents: grandTotalMicrocents,
          grand_total_usd: microcentsToUSD(grandTotalMicrocents),
        },
      },
    };
  }

  generateInvoiceStatement(tenantId) {
    const usageResult = this.getTenantUsageRollup(tenantId);
    if (usageResult.error) return usageResult;

    const { data } = usageResult;
    const lineItems = [
      {
        description: `Base Subscription Fee - ${data.plan.name}`,
        quantity: 1,
        unit_price_usd: data.costs.base_plan_fee_usd,
        total_microcents: data.costs.base_plan_fee_microcents,
        total_usd: data.costs.base_plan_fee_usd,
      },
      {
        description: `API Calls Metered (${data.quotas.api_calls.used} calls)`,
        quantity: data.quotas.api_calls.used,
        unit_rate: '$1.00 / 10k calls',
        total_microcents: data.costs.api_calls_microcents,
        total_usd: data.costs.api_calls_usd,
      },
      {
        description: `Fresh Input Tokens (${data.token_breakdown.fresh_input_tokens})`,
        quantity: data.token_breakdown.fresh_input_tokens,
        unit_rate: '$0.150 / 1M tokens',
        total_microcents: Math.round((data.token_breakdown.fresh_input_tokens * PRICING.TOKENS.FRESH_INPUT_PER_1K) / 1000),
        total_usd: microcentsToUSD(Math.round((data.token_breakdown.fresh_input_tokens * PRICING.TOKENS.FRESH_INPUT_PER_1K) / 1000)),
      },
      {
        description: `Cached Input Tokens (${data.token_breakdown.cached_input_tokens} - 50% discount)`,
        quantity: data.token_breakdown.cached_input_tokens,
        unit_rate: '$0.075 / 1M tokens',
        total_microcents: Math.round((data.token_breakdown.cached_input_tokens * PRICING.TOKENS.CACHED_INPUT_PER_1K) / 1000),
        total_usd: microcentsToUSD(Math.round((data.token_breakdown.cached_input_tokens * PRICING.TOKENS.CACHED_INPUT_PER_1K) / 1000)),
      },
      {
        description: `Output Tokens (${data.token_breakdown.output_tokens})`,
        quantity: data.token_breakdown.output_tokens,
        unit_rate: '$0.600 / 1M tokens',
        total_microcents: Math.round((data.token_breakdown.output_tokens * PRICING.TOKENS.OUTPUT_PER_1K) / 1000),
        total_usd: microcentsToUSD(Math.round((data.token_breakdown.output_tokens * PRICING.TOKENS.OUTPUT_PER_1K) / 1000)),
      },
      {
        description: `Reasoning Tokens (${data.token_breakdown.reasoning_tokens} - billed as output)`,
        quantity: data.token_breakdown.reasoning_tokens,
        unit_rate: '$0.600 / 1M tokens',
        total_microcents: Math.round((data.token_breakdown.reasoning_tokens * PRICING.TOKENS.REASONING_PER_1K) / 1000),
        total_usd: microcentsToUSD(Math.round((data.token_breakdown.reasoning_tokens * PRICING.TOKENS.REASONING_PER_1K) / 1000)),
      },
    ];

    return {
      statusCode: 200,
      data: {
        invoice_id: `inv_${Date.now()}_${tenantId}`,
        tenant_id: tenantId,
        billing_period: data.billing_period,
        plan: data.plan,
        line_items: lineItems,
        total_amount_microcents: data.costs.grand_total_microcents,
        total_amount_usd: data.costs.grand_total_usd,
        status: data.plan.status === 'past_due' ? 'past_due' : 'paid',
      },
    };
  }
}

module.exports = BillingService;
