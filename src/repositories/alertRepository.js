const { getDatabase } = require('../db/connection');
const crypto = require('node:crypto');

class AlertRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  hasAlerted(tenantId, resource, thresholdPercent, period) {
    const stmt = this.db.prepare(`
      SELECT 1 FROM usage_alerts 
      WHERE tenant_id = ? AND resource = ? AND threshold_percent = ? AND period = ?
    `);
    return !!stmt.get(tenantId, resource, thresholdPercent, period);
  }

  recordAlert(tenantId, resource, thresholdPercent, period) {
    const id = `alt_${crypto.randomUUID()}`;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO usage_alerts (id, tenant_id, resource, threshold_percent, period, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const res = stmt.run(id, tenantId, resource, thresholdPercent, period);
    return res.changes > 0;
  }

  getAlertsByTenant(tenantId) {
    const stmt = this.db.prepare('SELECT * FROM usage_alerts WHERE tenant_id = ? ORDER BY created_at DESC');
    return stmt.all(tenantId);
  }
}

module.exports = AlertRepository;
