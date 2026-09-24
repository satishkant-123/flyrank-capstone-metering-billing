const { getDatabase } = require('../db/connection');

class IdempotencyRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  getRecord(tenantId, key) {
    const compositeKey = `${tenantId}:${key}`;
    const stmt = this.db.prepare('SELECT * FROM idempotency_keys WHERE key = ?');
    const row = stmt.get(compositeKey);
    if (!row) return null;

    return {
      key: row.key,
      tenantId: row.tenant_id,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: JSON.parse(row.response_body),
      createdAt: row.created_at,
    };
  }

  saveRecord(tenantId, key, requestHash, responseStatus, responseBody) {
    const compositeKey = `${tenantId}:${key}`;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO idempotency_keys 
      (key, tenant_id, request_hash, response_status, response_body, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      compositeKey,
      tenantId,
      requestHash,
      responseStatus,
      JSON.stringify(responseBody)
    );
  }
}

module.exports = IdempotencyRepository;
