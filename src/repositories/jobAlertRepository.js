const { getDatabase } = require('../db/connection');
const crypto = require('node:crypto');

class JobAlertRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  recordFailureAlert({ jobName, error, attempts }) {
    const id = `job_alert_${crypto.randomUUID()}`;
    const stmt = this.db.prepare(`
      INSERT INTO job_failure_alerts (id, job_name, error_message, attempts, alert_status, created_at)
      VALUES (?, ?, ?, ?, 'DISPATCHED', datetime('now'))
    `);
    stmt.run(id, jobName, String(error), attempts);
    return id;
  }

  getAllAlerts() {
    const stmt = this.db.prepare('SELECT * FROM job_failure_alerts ORDER BY created_at DESC');
    return stmt.all();
  }
}

module.exports = JobAlertRepository;
