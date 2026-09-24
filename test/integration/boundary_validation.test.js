const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const createApp = require('../../src/app');
const { seedDatabase } = require('../../src/db/seed');

function dispatch(app, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const rawBody = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const stream = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
    const socket = new EventEmitter();
    socket.encrypted = false;
    socket.remoteAddress = '127.0.0.1';
    socket.destroy = () => {};

    const req = Object.assign(stream, {
      method,
      url,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(rawBody)),
        ...headers,
      },
      socket,
    });

    const chunks = [];
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof encoding === 'function') encoding();
      if (typeof cb === 'function') cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const respBody = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(respBody);
      } catch (e) {}
      if (typeof encoding === 'function') encoding();
      if (typeof cb === 'function') cb();
      resolve({ status: res.statusCode, body: json, rawBody: respBody });
    };

    app(req, res);
  });
}

test('Validation at the boundary - bad input returns clean 4xx, never 500', async () => {
  seedDatabase();
  const app = createApp();

  // 1. Missing tenant ID -> 400
  const missingTenant = await dispatch(app, {
    method: 'POST',
    url: '/generate',
    body: { prompt: 'hi' },
  });
  assert.equal(missingTenant.status, 400);
  assert.equal(missingTenant.body.error, 'invalid_request');
  assert.match(missingTenant.body.message, /tenant/i);

  // 2. Negative token value -> 400
  const negativeTokens = await dispatch(app, {
    method: 'POST',
    url: '/generate',
    headers: { 'x-tenant-id': 'tenant_free_1' },
    body: { fresh_input_tokens: -100 },
  });
  assert.equal(negativeTokens.status, 400);
  assert.equal(negativeTokens.body.error, 'invalid_request');
  assert.match(negativeTokens.body.message, /non-negative/i);

  // 3. Non-integer token value -> 400
  const floatTokens = await dispatch(app, {
    method: 'POST',
    url: '/generate',
    headers: { 'x-tenant-id': 'tenant_free_1' },
    body: { output_tokens: 3.1415 },
  });
  assert.equal(floatTokens.status, 400);
  assert.equal(floatTokens.body.error, 'invalid_request');

  // 4. Malformed JSON string -> 400
  const malformedJson = await dispatch(app, {
    method: 'POST',
    url: '/generate',
    headers: { 'x-tenant-id': 'tenant_free_1' },
    body: '{"prompt": invalid_json_syntax',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body.error, 'invalid_json');
});
