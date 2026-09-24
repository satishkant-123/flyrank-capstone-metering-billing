const WebhookEventRepository = require('../repositories/webhookEventRepository');
const TenantRepository = require('../repositories/tenantRepository');
const SubscriptionRepository = require('../repositories/subscriptionRepository');
const { getDatabase } = require('../db/connection');

class WebhookService {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.webhookRepo = deps.webhookRepo || new WebhookEventRepository(this._db);
    this.tenantRepo = deps.tenantRepo || new TenantRepository(this._db);
    this.subRepo = deps.subRepo || new SubscriptionRepository(this._db);
  }

  get db() {
    return this._db || getDatabase();
  }

  processEvent(event) {
    if (!event || !event.id) {
      return { success: false, statusCode: 400, message: 'Invalid event object' };
    }

    // 1. Deduplication check
    if (this.webhookRepo.isProcessed(event.id)) {
      return {
        success: true,
        statusCode: 200,
        duplicate: true,
        message: `Event '${event.id}' has already been processed. Replay ignored.`,
      };
    }

    this.db.exec('BEGIN TRANSACTION;');
    try {
      // 2. Mark event as processed
      this.webhookRepo.markProcessed(event.id, event.type);

      // 3. Handle event types
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const tenantId = session.metadata?.tenant_id || session.client_reference_id;

          if (tenantId) {
            // Upgrade tenant to Pro
            this.tenantRepo.updatePlan(tenantId, 'pro');
            if (session.customer) {
              this.tenantRepo.updateStripeCustomer(tenantId, session.customer);
            }

            const now = new Date();
            const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
            const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

            this.subRepo.upsert({
              id: session.subscription || `sub_${tenantId}_pro`,
              tenant_id: tenantId,
              plan_id: 'pro',
              status: 'active',
              current_period_start: start,
              current_period_end: end,
              stripe_customer_id: session.customer,
              stripe_subscription_id: session.subscription,
            });
          }
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const tenant = this.tenantRepo.getByStripeCustomerId(subscription.customer) ||
                         (subscription.metadata?.tenant_id ? this.tenantRepo.getById(subscription.metadata.tenant_id) : null);

          if (tenant) {
            const status = subscription.status; // 'active', 'past_due', 'canceled', etc.
            this.subRepo.upsert({
              id: subscription.id,
              tenant_id: tenant.id,
              plan_id: status === 'active' ? 'pro' : tenant.current_plan_id,
              status,
              current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
              stripe_customer_id: subscription.customer,
              stripe_subscription_id: subscription.id,
            });
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const tenant = this.tenantRepo.getByStripeCustomerId(subscription.customer) ||
                         (subscription.metadata?.tenant_id ? this.tenantRepo.getById(subscription.metadata.tenant_id) : null);

          if (tenant) {
            // Downgrade tenant to Free upon cancellation
            this.tenantRepo.updatePlan(tenant.id, 'free');
            this.subRepo.updateStatus(subscription.id, 'canceled');
          }
          break;
        }

        default:
          // Unhandled event type, silently acknowledged
          break;
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return {
      success: true,
      statusCode: 200,
      duplicate: false,
      eventId: event.id,
      eventType: event.type,
      message: `Event '${event.id}' processed successfully.`,
    };
  }
}

module.exports = WebhookService;
