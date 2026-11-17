import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSameOrigin, cleanText, clientIp, HttpError, isUuid, readJson, textField
} from '../src/http.js';

test('cleanText strips control characters and normalizes newlines', () => {
  const value = '  a\u0000b\r\nc\n\n\n\nd  ';
  assert.equal(cleanText(value, 100), 'ab\nc\n\nd');
});

test('textField rejects values over the limit', () => {
  assert.throws(() => textField('x'.repeat(11), 10, 'too_long'), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'too_long');
    assert.equal(error.status, 413);
    return true;
  });
});

test('isUuid accepts canonical UUIDs only', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400'), false);
  assert.equal(isUuid('not-a-uuid'), false);
});

test('clientIp prefers CF-Connecting-IP and rejects spoofed junk', () => {
  const request = new Request('https://example.com/api/health', {
    headers: {
      'cf-connecting-ip': '203.0.113.9',
      'x-real-ip': '198.51.100.7',
      'x-forwarded-for': '192.0.2.1, 10.0.0.1'
    }
  });
  assert.equal(clientIp(request), '203.0.113.9');

  const junk = new Request('https://example.com/', {
    headers: { 'cf-connecting-ip': '<script>' }
  });
  assert.equal(clientIp(junk), 'unknown');
});

test('readJson enforces content type, size and object shape', async () => {
  const good = new Request('https://example.com/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  });
  assert.deepEqual(await readJson(good), { hello: 'world' });

  const wrongType = new Request('https://example.com/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}'
  });
  await assert.rejects(readJson(wrongType), (error) => error.code === 'invalid_content_type');

  const tooLarge = new Request('https://example.com/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a'.repeat(33000) })
  });
  await assert.rejects(readJson(tooLarge), (error) => error.code === 'payload_too_large');

  const malformed = new Request('https://example.com/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad'
  });
  await assert.rejects(readJson(malformed), (error) => {
    assert.equal(error.code, 'invalid_json');
    assert.equal(error.rawText, '{bad');
    return true;
  });

  const array = new Request('https://example.com/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]'
  });
  await assert.rejects(readJson(array), (error) => error.code === 'invalid_input');
});

test('assertSameOrigin blocks cross-origin and cross-site writes', () => {
  const same = new Request('https://essay.example.com/api/grade', {
    method: 'POST',
    headers: { origin: 'https://essay.example.com' }
  });
  assert.doesNotThrow(() => assertSameOrigin(same));

  const crossOrigin = new Request('https://essay.example.com/api/grade', {
    method: 'POST',
    headers: { origin: 'https://evil.example.com' }
  });
  assert.throws(() => assertSameOrigin(crossOrigin), (error) => error.code === 'cross_origin_rejected');

  const crossSite = new Request('https://essay.example.com/api/grade', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.throws(() => assertSameOrigin(crossSite), (error) => error.code === 'cross_origin_rejected');

  const curl = new Request('https://essay.example.com/api/grade', { method: 'POST' });
  assert.doesNotThrow(() => assertSameOrigin(curl));
});
