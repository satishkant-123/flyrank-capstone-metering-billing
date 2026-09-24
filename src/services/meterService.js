const crypto = require('node:crypto');
const { getDatabase } = require('../db/connection');
const UsageEventRepository = require('../repositories/usageEventRepository');
const IdempotencyRepository = require('../repositories/idempotencyRepository');
const QuotaService = require('./quotaService');
const PricingService = require('./pricingService');

class MeterService {
  constructor(deps = {}) {
    this._db = deps.db || null;
    this.usageRepo = deps.usageRepo || new UsageEventRepository(this._db);
    this.idempotencyRepo = deps.idempotencyRepo || new IdempotencyRepository(this._db);
    this.quotaService = deps.quotaService || new QuotaService(deps);
  }

  get db() {
    return this._db || getDatabase();
  }

  hashPayload(payload) {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Record a billable event idempotently and atomically under concurrent load.
   * Concurrency protection: Uses SQLite BEGIN IMMEDIATE to lock writer before checking quota.
   */
  record({
    tenantId,
    eventType = 'ai_tokens', // 'ai_tokens' or 'api_call'
    tokenBreakdown = {},
    apiCallCount = 1,
    idempotencyKey = null,
    requestPayload = null,
  }) {
    const payloadHash = this.hashPayload(requestPayload || { eventType, tokenBreakdown, apiCallCount });

    // Begin atomic immediate transaction to serialize concurrent quota checks and inserts
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      // 1. Idempotency Check
      if (idempotencyKey) {
        const existing = this.idempotencyRepo.getRecord(tenantId, idempotencyKey);
        if (existing) {
          this.db.exec('COMMIT;');
          if (existing.requestHash !== payloadHash) {
            return {
              statusCode: 409,
              body: {
                error: 'idempotency_conflict',
                message: `Idempotency key '${idempotencyKey}' was previously used with a different request payload.`,
              },
              isIdempotentReplay: true,
            };
          }

          return {
            statusCode: existing.responseStatus,
            body: existing.responseBody,
            isIdempotentReplay: true,
          };
        }
      }

      // 2. Determine quantity and pricing
      let quantity = 0;
      let costMicrocents = 0;
      let pricingResult = null;

      if (eventType === 'ai_tokens') {
        pricingResult = PricingService.calculateTokenCost(tokenBreakdown);
        quantity = pricingResult.total_tokens;
        costMicrocents = pricingResult.cost_microcents;
      } else {
        // api_call
        pricingResult = PricingService.calculateApiCallCost(apiCallCount);
        quantity = pricingResult.api_calls;
        costMicrocents = pricingResult.cost_microcents;
      }

      // 3. Quota Enforcement (Evaluated inside locked transaction)
      const quotaCheck = this.quotaService.checkQuota({
        tenantId,
        requestedType: eventType,
        requestedQty: quantity,
      });

      if (!quotaCheck.allowed) {
        this.db.exec('COMMIT;');
        const errorBody = {
          error: quotaCheck.error,
          message: quotaCheck.message,
          resource: quotaCheck.resource,
          limit: quotaCheck.limit,
          used: quotaCheck.used,
          requested: quotaCheck.requested,
          remaining: quotaCheck.remaining,
        };

        if (quotaCheck.subscription_status) {
          errorBody.subscription_status = quotaCheck.subscription_status;
        }

        return {
          statusCode: quotaCheck.statusCode,
          body: errorBody,
          headers: quotaCheck.retryAfter ? { 'Retry-After': String(quotaCheck.retryAfter) } : {},
          isIdempotentReplay: false,
        };
      }

      // 4. Persistence within ACID Transaction
      const eventId = `evt_${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      const responseBody = {
        success: true,
        event_id: eventId,
        tenant_id: tenantId,
        event_type: eventType,
        quantity,
        cost_microcents: costMicrocents,
        cost_usd: pricingResult.cost_usd,
        cost_cents: pricingResult.cost_cents,
        breakdown: eventType === 'ai_tokens' ? {
          cached_input_tokens: pricingResult.cached_input_tokens,
          fresh_input_tokens: pricingResult.fresh_input_tokens,
          output_tokens: pricingResult.output_tokens,
          reasoning_tokens: pricingResult.reasoning_tokens,
        } : {
          api_calls: pricingResult.api_calls,
        },
        quota_balance: {
          resource: quotaCheck.resource,
          limit: quotaCheck.limit,
          used: quotaCheck.newUsage,
          remaining: quotaCheck.remaining,
        },
        timestamp: now,
      };

      this.usageRepo.insert({
        id: eventId,
        tenant_id: tenantId,
        event_type: eventType,
        quantity,
        cached_input_tokens: tokenBreakdown.cached_input_tokens || 0,
        fresh_input_tokens: tokenBreakdown.fresh_input_tokens || 0,
        output_tokens: tokenBreakdown.output_tokens || 0,
        reasoning_tokens: tokenBreakdown.reasoning_tokens || 0,
        cost_microcents: costMicrocents,
        idempotency_key: idempotencyKey,
        created_at: now,
      });

      if (idempotencyKey) {
        this.idempotencyRepo.saveRecord(tenantId, idempotencyKey, payloadHash, 200, responseBody);
      }

      this.db.exec('COMMIT;');

      return {
        statusCode: 200,
        body: responseBody,
        headers: {},
        isIdempotentReplay: false,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Transaction may already be closed
      }
      throw err;
    }
  }
}

module.exports = MeterService;
