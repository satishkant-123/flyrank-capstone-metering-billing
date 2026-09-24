const { getDatabase } = require('../db/connection');

class WebhookEventRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  isProcessed(eventId) {
    const stmt = this.db.prepare('SELECT 1 FROM processed_webhook_events WHERE event_id = ?');
    return !!stmt.get(eventId);
  }

  markProcessed(eventId, eventType) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_webhook_events (event_id, event_type, processed_at)
      VALUES (?, ?, datetime('now'))
    `);
    const result = stmt.run(eventId, eventType);
    return result.changes > 0;
  }
}

module.exports = WebhookEventRepository;
