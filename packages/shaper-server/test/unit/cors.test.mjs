import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCors, parseAllowedOrigins } from '../../src/http/cors.mjs';

const origin = 'http://172.27.46.183:4173';

function createResponse() {
  const headers = new Map();
  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
  };
}

function createRequest({ method = 'GET', originHeader = origin, headers = {} } = {}) {
  return {
    method,
    headers: {
      ...(originHeader ? { origin: originHeader } : {}),
      ...headers,
    },
  };
}

test('parses comma-separated allowed origins', () => {
  const origins = parseAllowedOrigins(`${origin}, http://localhost:4173, `);
  assert.equal(origins.size, 2);
  assert.ok(origins.has(origin));
  assert.ok(origins.has('http://localhost:4173'));
});

test('allows configured origins and sets CORS response headers', () => {
  const response = createResponse();
  const result = applyCors(createRequest(), response, new Set([origin]));

  assert.deepEqual(result, { allowed: true, preflight: false });
  assert.equal(response.getHeader('access-control-allow-origin'), origin);
  assert.equal(response.getHeader('vary'), 'Origin');
  assert.ok(response.getHeader('access-control-expose-headers').includes('Content-Range'));
});

test('rejects unconfigured origins', () => {
  const response = createResponse();
  const result = applyCors(
    createRequest({ originHeader: 'http://evil.example' }),
    response,
    new Set([origin]),
  );

  assert.equal(result.allowed, false);
  assert.equal(response.getHeader('access-control-allow-origin'), undefined);
});

test('allows browser POST preflight requests', () => {
  const response = createResponse();
  const result = applyCors(
    createRequest({
      method: 'OPTIONS',
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    }),
    response,
    new Set([origin]),
  );

  assert.deepEqual(result, { allowed: true, preflight: true });
  assert.equal(response.getHeader('access-control-allow-origin'), origin);
  assert.ok(response.getHeader('access-control-allow-methods').includes('POST'));
});

test('rejects unsupported preflight methods', () => {
  const result = applyCors(
    createRequest({
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'DELETE' },
    }),
    createResponse(),
    new Set([origin]),
  );

  assert.equal(result.allowed, false);
});

test('rejects unsupported preflight headers', () => {
  const result = applyCors(
    createRequest({
      method: 'OPTIONS',
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-secret-token',
      },
    }),
    createResponse(),
    new Set([origin]),
  );

  assert.equal(result.allowed, false);
});
