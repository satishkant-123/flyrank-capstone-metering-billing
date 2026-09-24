const { getDatabase } = require('../db/connection');
const crypto = require('node:crypto');

class UsageEventRepository {
  constructor(db = null) {
    this._db = db;
  }

  get db() {
    return this._db || getDatabase();
  }

  insert(event) {
    const id = event.id || `evt_${crypto.randomUUID()}`;
    const stmt = this.db.prepare(`
      INSERT INTO usage_events 
      (id, tenant_id, event_type, quantity, cached_input_tokens, fresh_input_tokens, output_tokens, reasoning_tokens, cost_microcents, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `);

    stmt.run(
      id,
      event.tenant_id,
      event.event_type,
      event.quantity,
      event.cached_input_tokens || 0,
      event.fresh_input_tokens || 0,
      event.output_tokens || 0,
      event.reasoning_tokens || 0,
      event.cost_microcents,
      event.idempotency_key || null,
      event.created_at || null
    );

    return this.getById(id);
  }

  getById(id) {
    const stmt = this.db.prepare('SELECT * FROM usage_events WHERE id = ?');
    return stmt.get(id) || null;
  }

  getRollup(tenantId, periodStart, periodEnd) {
    const stmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN event_type = 'api_call' THEN quantity ELSE 0 END), 0) as total_api_calls,
        COALESCE(SUM(CASE WHEN event_type = 'api_call' THEN cost_microcents ELSE 0 END), 0) as api_call_cost_microcents,
        COALESCE(SUM(quantity), 0) as total_units,
        COALESCE(SUM(cached_input_tokens), 0) as cached_input_tokens,
        COALESCE(SUM(fresh_input_tokens), 0) as fresh_input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(SUM(CASE WHEN event_type = 'ai_tokens' THEN quantity ELSE 0 END), 0) as total_tokens,
        COALESCE(SUM(CASE WHEN event_type = 'ai_tokens' THEN cost_microcents ELSE 0 END), 0) as tokens_cost_microcents,
        COALESCE(SUM(cost_microcents), 0) as total_cost_microcents
      FROM usage_events
      WHERE tenant_id = ?
        AND created_at >= ?
        AND created_at <= ?
    `);

    const row = stmt.get(tenantId, periodStart, periodEnd);
    return {
      total_api_calls: Number(row.total_api_calls || 0),
      api_call_cost_microcents: Number(row.api_call_cost_microcents || 0),
      total_tokens: Number(row.total_tokens || 0),
      cached_input_tokens: Number(row.cached_input_tokens || 0),
      fresh_input_tokens: Number(row.fresh_input_tokens || 0),
      output_tokens: Number(row.output_tokens || 0),
      reasoning_tokens: Number(row.reasoning_tokens || 0),
      tokens_cost_microcents: Number(row.tokens_cost_microcents || 0),
      total_cost_microcents: Number(row.total_cost_microcents || 0),
    };
  }

  getEventsByTenant(tenantId, limit = 100) {
    const stmt = this.db.prepare('SELECT * FROM usage_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?');
    return stmt.all(tenantId, limit);
  }
}

module.exports = UsageEventRepository;
