const SubscriptionRepository = require('../repositories/subscriptionRepository');
const TenantRepository = require('../repositories/tenantRepository');
const StripeService = require('../services/stripeService');
const JobFailureAlertRepository = require('../repositories/jobFailureAlertRepository');

class ReconciliationJob {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.subRepo = deps.subRepo || new SubscriptionRepository(this._db);
    this.tenantRepo = deps.tenantRepo || new TenantRepository(this._db);
    this.stripeService = deps.stripeService || new StripeService();
    this.jobAlertRepo = deps.jobAlertRepo || new JobFailureAlertRepository(this._db);
  }

  /**
   * Execute an operation with exponential backoff retries.
   * Attempt 1 -> failure -> Attempt 2 -> failure -> Attempt 3 -> failure -> Failure Alert
   */
  async executeWithRetry(operation, maxRetries = 3, baseDelayMs = 20) {
    let attempt = 0;
    const attemptsLog = [];

    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await operation();
        attemptsLog.push({ attempt, status: 'succeeded' });
        return { success: true, result, attempts: attempt, attemptsLog };
      } catch (err) {
        attemptsLog.push({ attempt, status: 'failed', error: err.message });
        console.warn(`[ReconciliationJob] Attempt ${attempt} failed: ${err.message}`);

        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries failed -> Generate failure alert
    const finalError = attemptsLog[attemptsLog.length - 1].error;
    console.error(`[ReconciliationJob] All ${maxRetries} attempts failed. Generating job failure alert.`);

    const alertId = this.jobAlertRepo.recordFailureAlert({
      jobName: 'reconciliation',
      error: finalError,
      attempts: maxRetries,
    });

    return {
      success: false,
      error: finalError,
      attempts: maxRetries,
      attemptsLog,
      alertId,
      alertStatus: 'DISPATCHED',
    };
  }

  /**
   * Run reconciliation pass comparing local DB subscriptions against Stripe truth.
   */
  async run() {
    console.log('[ReconciliationJob] Starting subscription reconciliation run...');
    const subscriptions = this.subRepo.getAll();
    const anomalies = [];
    const retryAuditLog = [];
    let checkedCount = 0;
    let syncedCount = 0;

    for (const sub of subscriptions) {
      if (!sub.stripe_subscription_id) continue;
      checkedCount++;

      const retryResult = await this.executeWithRetry(async () => {
        // Retrieve subscription from Stripe
        return await this.stripeService.stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      }, 3, 20);

      retryAuditLog.push({
        subscriptionId: sub.id,
        tenantId: sub.tenant_id,
        retryResult,
      });

      if (!retryResult.success) {
        anomalies.push({
          subscriptionId: sub.id,
          tenantId: sub.tenant_id,
          error: retryResult.error,
          attempts: retryResult.attempts,
          alertId: retryResult.alertId,
          action: 'FAILURE_ALERT_DISPATCHED',
        });
        continue;
      }

      const stripeSub = retryResult.result;
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
    }

    const report = {
      timestamp: new Date().toISOString(),
      checkedCount,
      syncedCount,
      anomaliesCount: anomalies.length,
      anomalies,
      retryAuditLog,
      status: anomalies.filter(a => a.error).length > 0 ? 'ALERT_TRIGGERED' : 'HEALTHY',
    };

    console.log('[ReconciliationJob] Reconciliation complete:', JSON.stringify(report));
    return report;
  }
}

module.exports = ReconciliationJob;
