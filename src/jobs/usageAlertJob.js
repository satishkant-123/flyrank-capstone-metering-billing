const TenantRepository = require('../repositories/tenantRepository');
const PlanRepository = require('../repositories/planRepository');
const SubscriptionRepository = require('../repositories/subscriptionRepository');
const UsageEventRepository = require('../repositories/usageEventRepository');
const AlertRepository = require('../repositories/alertRepository');

class UsageAlertJob {
  constructor(deps = {}) {
    this.tenantRepo = deps.tenantRepo || new TenantRepository();
    this.planRepo = deps.planRepo || new PlanRepository();
    this.subRepo = deps.subRepo || new SubscriptionRepository();
    this.usageRepo = deps.usageRepo || new UsageEventRepository();
    this.alertRepo = deps.alertRepo || new AlertRepository();
  }

  run() {
    const tenants = this.tenantRepo.getAll();
    const alertsTriggered = [];

    const now = new Date();
    const periodMonth = now.toISOString().slice(0, 7);
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    for (const tenant of tenants) {
      const plan = this.planRepo.getById(tenant.current_plan_id);
      if (!plan) continue;

      const rollup = this.usageRepo.getRollup(tenant.id, startOfMonth, endOfMonth);

      // 1. Check API calls
      const apiCallsPercent = plan.monthly_api_limit > 0 ? (rollup.total_api_calls / plan.monthly_api_limit) * 100 : 0;
      if (apiCallsPercent >= 100) {
        if (!this.alertRepo.hasAlerted(tenant.id, 'api_calls', 100, periodMonth)) {
          this.alertRepo.recordAlert(tenant.id, 'api_calls', 100, periodMonth);
          alertsTriggered.push({ tenantId: tenant.id, resource: 'api_calls', threshold: 100, used: rollup.total_api_calls, limit: plan.monthly_api_limit });
        }
      } else if (apiCallsPercent >= 80) {
        if (!this.alertRepo.hasAlerted(tenant.id, 'api_calls', 80, periodMonth)) {
          this.alertRepo.recordAlert(tenant.id, 'api_calls', 80, periodMonth);
          alertsTriggered.push({ tenantId: tenant.id, resource: 'api_calls', threshold: 80, used: rollup.total_api_calls, limit: plan.monthly_api_limit });
        }
      }

      // 2. Check AI tokens
      const tokensPercent = plan.monthly_token_limit > 0 ? (rollup.total_tokens / plan.monthly_token_limit) * 100 : 0;
      if (tokensPercent >= 100) {
        if (!this.alertRepo.hasAlerted(tenant.id, 'ai_tokens', 100, periodMonth)) {
          this.alertRepo.recordAlert(tenant.id, 'ai_tokens', 100, periodMonth);
          alertsTriggered.push({ tenantId: tenant.id, resource: 'ai_tokens', threshold: 100, used: rollup.total_tokens, limit: plan.monthly_token_limit });
        }
      } else if (tokensPercent >= 80) {
        if (!this.alertRepo.hasAlerted(tenant.id, 'ai_tokens', 80, periodMonth)) {
          this.alertRepo.recordAlert(tenant.id, 'ai_tokens', 80, periodMonth);
          alertsTriggered.push({ tenantId: tenant.id, resource: 'ai_tokens', threshold: 80, used: rollup.total_tokens, limit: plan.monthly_token_limit });
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      checkedTenantsCount: tenants.length,
      alertsCount: alertsTriggered.length,
      alerts: alertsTriggered,
    };
  }
}

module.exports = UsageAlertJob;
