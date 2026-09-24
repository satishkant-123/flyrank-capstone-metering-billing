const test = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../../src/app');
const http = require('node:http');

test('Validation at the boundary - bad input returns clean 4xx, never 500', async () => {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function post(path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  // 1. Missing tenant ID -> 400
  const missingTenant = await post('/generate', { prompt: 'hi' });
  assert.equal(missingTenant.status, 400);
  assert.equal(missingTenant.body.error, 'invalid_request');
  assert.match(missingTenant.body.message, /tenant/i);

  // 2. Negative token value -> 400
  const negativeTokens = await post(
    '/generate',
    { fresh_input_tokens: -100 },
    { 'x-tenant-id': 'tenant_free_1' }
  );
  assert.equal(negativeTokens.status, 400);
  assert.equal(negativeTokens.body.error, 'invalid_request');
  assert.match(negativeTokens.body.message, /non-negative/i);

  // 3. Non-integer token value -> 400
  const floatTokens = await post(
    '/generate',
    { output_tokens: 3.1415 },
    { 'x-tenant-id': 'tenant_free_1' }
  );
  assert.equal(floatTokens.status, 400);
  assert.equal(floatTokens.body.error, 'invalid_request');

  // 4. Malformed JSON string -> 400
  const malformedJson = await post('/generate', '{"prompt": invalid_json_syntax', {
    'x-tenant-id': 'tenant_free_1',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error, 'invalid_json');

  server.close();
});
