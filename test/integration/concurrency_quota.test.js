const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  // WORKER THREAD CODE: Runs on separate OS thread
  const { dbPath, tenantId, idempotencyKey } = workerData;
  const { DatabaseSync } = require('node:sqlite');
  const MeterService = require('../../src/services/meterService');
  const UsageEventRepository = require('../../src/repositories/usageEventRepository');
  const IdempotencyRepository = require('../../src/repositories/idempotencyRepository');
  const TenantRepository = require('../../src/repositories/tenantRepository');
  const PlanRepository = require('../../src/repositories/planRepository');
  const SubscriptionRepository = require('../../src/repositories/subscriptionRepository');
  const AlertRepository = require('../../src/repositories/alertRepository');
  const QuotaService = require('../../src/services/quotaService');

  // Open separate connection to shared SQLite DB
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;'); // Wait up to 5s if locked
  db.exec('PRAGMA journal_mode = WAL;');

  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageEventRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const alertRepo = new AlertRepository(db);
  const quotaService = new QuotaService({ tenantRepo, planRepo, subRepo, usageRepo, alertRepo });

  const meterService = new MeterService({ db, usageRepo, idempotencyRepo, quotaService });

  parentPort.on('message', (msg) => {
    if (msg === 'FIRE') {
      try {
        const result = meterService.record({
          tenantId,
          eventType: 'api_call',
          apiCallCount: 1,
          idempotencyKey,
        });
        db.close();
        parentPort.postMessage({ success: true, statusCode: result.statusCode, body: result.body });
      } catch (err) {
        db.close();
        parentPort.postMessage({ success: false, error: err.message });
      }
    }
  });
} else {
  // MAIN TEST THREAD
  test('Concurrency Safety - Genuine multi-threaded OS workers racing at boundary (999/1000)', async () => {
    const testDbPath = path.join(__dirname, `test_concurrency_${Date.now()}.db`);
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = new DatabaseSync(testDbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_initial_schema.sql'), 'utf8');
    db.exec(sql);

    // Free plan: 1,000 calls
    db.prepare(`
      INSERT INTO plans (id, name, monthly_api_limit, monthly_token_limit, base_fee_microcents)
      VALUES ('free', 'Free Tier', 1000, 100000, 0)
    `).run();

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?, datetime(\'now\'))').run(
      'tenant_race_thread', 'MultiThread Org', 'thread@test.com', 'free', null
    );

    db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))').run(
      'sub_race_thread', 'tenant_race_thread', 'free', 'active', start, end, null, null
    );

    // Pre-seed exactly 999 calls
    db.prepare(`
      INSERT INTO usage_events (id, tenant_id, event_type, quantity, cost_microcents, created_at)
      VALUES ('evt_pre_999_thread', 'tenant_race_thread', 'api_call', 999, 99900, datetime('now'))
    `).run();

    db.close(); // Close main connection so workers access file concurrently

    // Spawn 2 genuine OS worker threads
    function spawnWorker(idempotencyKey) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
          workerData: {
            dbPath: testDbPath,
            tenantId: 'tenant_race_thread',
            idempotencyKey,
          },
        });

        worker.on('message', (msg) => {
          worker.terminate().then(() => resolve(msg));
        });
        worker.on('error', (err) => {
          worker.terminate().then(() => reject(err));
        });

        // Fire worker
        setImmediate(() => worker.postMessage('FIRE'));
      });
    }

    const [workerA, workerB] = await Promise.all([
      spawnWorker('thread_key_A'),
      spawnWorker('thread_key_B'),
    ]);

    assert.equal(workerA.success, true);
    assert.equal(workerB.success, true);

    const statusCodes = [workerA.statusCode, workerB.statusCode].sort();

    // Exactly one thread must receive 200 (allowed) and one must receive 429 (quota exceeded)
    assert.deepEqual(
      statusCodes,
      [200, 429],
      `Expected [200, 429] from concurrent threads, got: [${statusCodes.join(', ')}]`
    );

    // Reopen DB and verify usage strictly equals 1,000
    const verifyDb = new DatabaseSync(testDbPath);
    const countRow = verifyDb.prepare(`
      SELECT SUM(quantity) as total 
      FROM usage_events 
      WHERE tenant_id = 'tenant_race_thread' AND event_type = 'api_call'
    `).get();

    assert.equal(Number(countRow.total), 1000, 'Total calls must be strictly 1,000 - no over-allocation!');

    verifyDb.close();
    try {
      fs.unlinkSync(testDbPath);
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    } catch {}
  });
}
