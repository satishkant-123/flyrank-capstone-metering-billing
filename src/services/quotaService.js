const TenantRepository = require('../repositories/tenantRepository');
const PlanRepository = require('../repositories/planRepository');
const SubscriptionRepository = require('../repositories/subscriptionRepository');
const UsageEventRepository = require('../repositories/usageEventRepository');
const AlertRepository = require('../repositories/alertRepository');

class QuotaService {
  constructor(deps = {}) {
    this.tenantRepo = deps.tenantRepo || new TenantRepository();
    this.planRepo = deps.planRepo || new PlanRepository();
    this.subRepo = deps.subRepo || new SubscriptionRepository();
    this.usageRepo = deps.usageRepo || new UsageEventRepository();
    this.alertRepo = deps.alertRepo || new AlertRepository();
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

  checkQuota({ tenantId, requestedType, requestedQty }) {
    const tenant = this.tenantRepo.getById(tenantId);
    if (!tenant) {
      return {
        allowed: false,
        statusCode: 404,
        error: 'tenant_not_found',
        message: `Tenant '${tenantId}' does not exist.`,
      };
    }

    const plan = this.planRepo.getById(tenant.current_plan_id);
    if (!plan) {
      return {
        allowed: false,
        statusCode: 500,
        error: 'plan_not_found',
        message: `Plan '${tenant.current_plan_id}' configuration is missing.`,
      };
    }

    const subscription = this.subRepo.getByTenantId(tenantId);
    
    // Status Code 402 Payment Required:
    // If tenant subscription status is lapsed, past_due, canceled, or unpaid
    if (subscription && ['past_due', 'canceled', 'unpaid', 'incomplete'].includes(subscription.status)) {
      return {
        allowed: false,
        statusCode: 402,
        error: 'payment_required',
        message: `Subscription for tenant '${tenantId}' is '${subscription.status}'. An active payment method is required to proceed.`,
        subscription_status: subscription.status,
      };
    }

    const period = this.getCurrentBillingPeriod(subscription);
    const rollup = this.usageRepo.getRollup(tenantId, period.start, period.end);

    const isApiCall = requestedType === 'api_call';
    const isTokens = requestedType === 'ai_tokens';

    const currentUsage = isApiCall ? rollup.total_api_calls : rollup.total_tokens;
    const limit = isApiCall ? plan.monthly_api_limit : plan.monthly_token_limit;
    const resourceName = isApiCall ? 'api_calls' : 'ai_tokens';

    // Strict boundary check: (current + requested) > limit
    if (currentUsage + requestedQty > limit) {
      return {
        allowed: false,
        statusCode: 429,
        error: 'quota_exceeded',
        message: `Monthly ${resourceName} quota exceeded for plan '${plan.name}'. Limit: ${limit}, Used: ${currentUsage}, Requested: ${requestedQty}.`,
        resource: resourceName,
        limit,
        used: currentUsage,
        requested: requestedQty,
        remaining: Math.max(0, limit - currentUsage),
        retryAfter: 3600, // Seconds until retry / next evaluation
      };
    }

    // Check usage thresholds for alerts (80%, 100%)
    this.checkThresholdAlerts(tenantId, resourceName, currentUsage + requestedQty, limit, period.start.slice(0, 7));

    return {
      allowed: true,
      plan,
      subscription,
      period,
      currentUsage,
      newUsage: currentUsage + requestedQty,
      limit,
      remaining: limit - (currentUsage + requestedQty),
      resource: resourceName,
    };
  }

  checkThresholdAlerts(tenantId, resource, newUsage, limit, periodMonth) {
    const percentage = Math.floor((newUsage / limit) * 100);

    if (percentage >= 100) {
      if (!this.alertRepo.hasAlerted(tenantId, resource, 100, periodMonth)) {
        this.alertRepo.recordAlert(tenantId, resource, 100, periodMonth);
      }
    } else if (percentage >= 80) {
      if (!this.alertRepo.hasAlerted(tenantId, resource, 80, periodMonth)) {
        this.alertRepo.recordAlert(tenantId, resource, 80, periodMonth);
      }
    }
  }
}

module.exports = QuotaService;
