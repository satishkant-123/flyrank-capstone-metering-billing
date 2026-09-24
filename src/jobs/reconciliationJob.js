const SubscriptionRepository = require('../repositories/subscriptionRepository');
const TenantRepository = require('../repositories/tenantRepository');
const StripeService = require('../services/stripeService');

class ReconciliationJob {
  constructor(deps = {}) {
    this.subRepo = deps.subRepo || new SubscriptionRepository();
    this.tenantRepo = deps.tenantRepo || new TenantRepository();
    this.stripeService = deps.stripeService || new StripeService();
  }

  /**
   * Run reconciliation pass comparing local DB subscriptions against Stripe truth.
   */
  async run() {
    console.log('[ReconciliationJob] Starting subscription reconciliation run...');
    const subscriptions = this.subRepo.getAll();
    const anomalies = [];
    let checkedCount = 0;
    let syncedCount = 0;

    for (const sub of subscriptions) {
      if (!sub.stripe_subscription_id) continue;
      checkedCount++;

      try {
        let stripeSub = null;
        try {
          stripeSub = await this.stripeService.stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        } catch (apiErr) {
          // If mock or offline mode, simulate sync check
          if (this.stripeService.secretKey.includes('mock') || this.stripeService.secretKey.includes('placeholder')) {
            continue;
          }
          throw apiErr;
        }

        if (stripeSub && stripeSub.status !== sub.status) {
          anomalies.push({
            subscriptionId: sub.id,
            tenantId: sub.tenant_id,
            dbStatus: sub.status,
            stripeStatus: stripeSub.status,
            action: 'SYNCHRONIZED',
          });

          this.subRepo.updateStatus(sub.id, stripeSub.status);
          syncedCount++;
        }
      } catch (err) {
        console.error(`[ReconciliationJob] Error checking subscription ${sub.id}:`, err.message);
        anomalies.push({
          subscriptionId: sub.id,
          tenantId: sub.tenant_id,
          error: err.message,
          action: 'ALERT_TRIGGERED',
        });
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      checkedCount,
      syncedCount,
      anomaliesCount: anomalies.length,
      anomalies,
      status: anomalies.filter(a => a.error).length > 0 ? 'WARNING_ANOMALIES_DETECTED' : 'HEALTHY',
    };

    console.log('[ReconciliationJob] Reconciliation complete:', JSON.stringify(report));
    return report;
  }
}

module.exports = ReconciliationJob;
