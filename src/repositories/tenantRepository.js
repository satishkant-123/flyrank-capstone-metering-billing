const { getDatabase } = require('../db/connection');

class TenantRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  getById(id) {
    const stmt = this.db.prepare('SELECT * FROM tenants WHERE id = ?');
    return stmt.get(id) || null;
  }

  getByStripeCustomerId(stripeCustomerId) {
    const stmt = this.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?');
    return stmt.get(stripeCustomerId) || null;
  }

  updatePlan(id, planId) {
    const stmt = this.db.prepare('UPDATE tenants SET current_plan_id = ? WHERE id = ?');
    stmt.run(planId, id);
    return this.getById(id);
  }

  updateStripeCustomer(id, stripeCustomerId) {
    const stmt = this.db.prepare('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?');
    stmt.run(stripeCustomerId, id);
    return this.getById(id);
  }

  getAll() {
    const stmt = this.db.prepare('SELECT * FROM tenants');
    return stmt.all();
  }
}

module.exports = TenantRepository;
