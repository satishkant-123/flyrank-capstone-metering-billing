const { getDatabase } = require('../db/connection');

class SubscriptionRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  getByTenantId(tenantId) {
    const stmt = this.db.prepare('SELECT rowid, * FROM subscriptions WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1');
    return stmt.get(tenantId) || null;
  }

  getByStripeSubscriptionId(stripeSubscriptionId) {
    const stmt = this.db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?');
    return stmt.get(stripeSubscriptionId) || null;
  }

  upsert(subscription) {
    const existing = this.getByTenantId(subscription.tenant_id);
    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE subscriptions 
        SET id = ?, plan_id = ?, status = ?, current_period_start = ?, current_period_end = ?, stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = datetime('now')
        WHERE rowid = ?
      `);
      stmt.run(
        subscription.id || existing.id,
        subscription.plan_id,
        subscription.status,
        subscription.current_period_start,
        subscription.current_period_end,
        subscription.stripe_customer_id || null,
        subscription.stripe_subscription_id || null,
        existing.rowid
      );
      return this.getByTenantId(subscription.tenant_id);
    }

    const stmt = this.db.prepare(`
      INSERT INTO subscriptions 
      (id, tenant_id, plan_id, status, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      subscription.id,
      subscription.tenant_id,
      subscription.plan_id,
      subscription.status,
      subscription.current_period_start,
      subscription.current_period_end,
      subscription.stripe_customer_id || null,
      subscription.stripe_subscription_id || null
    );

    return this.getByTenantId(subscription.tenant_id);
  }

  updateStatus(id, status) {
    const stmt = this.db.prepare('UPDATE subscriptions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?');
    stmt.run(status, id);
    const sub = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    return sub || null;
  }

  getAll() {
    const stmt = this.db.prepare('SELECT * FROM subscriptions');
    return stmt.all();
  }
}

module.exports = SubscriptionRepository;
