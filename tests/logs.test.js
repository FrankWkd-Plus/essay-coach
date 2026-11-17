import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_TYPES, getLog, getStats, listLogs, logEvent, logEventSafe, maskIp } from '../src/logs.js';

function recordingDb(row = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          const statement = {
            sql,
            args,
            first: async () => row,
            run: async () => ({ meta: { changes: 1 }, results: [] })
          };
          calls.push(statement);
          return statement;
        }
      };
    }
  };
}

test('maskIp hides the host portion', () => {
  assert.equal(maskIp('203.0.113.42'), '203.0.113.*');
  assert.equal(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:8d3:*');
  assert.equal(maskIp('unknown'), 'unknown');
  assert.equal(maskIp(''), 'unknown');
});

test('event types include all telemetry categories used by the app', () => {
  for (const type of [
    'ai_request', 'ai_result', 'ai_error', 'ai_invalid_output',
    'validation_error', 'rate_limited', 'admin_login_ok', 'admin_login_failed',
    'admin_view', 'admin_cleanup', 'cron_cleanup'
  ]) {
    assert.ok(EVENT_TYPES.includes(type), type);
  }
});

test('logEvent serializes content and metadata into D1 parameters', async () => {
  const db = recordingDb();
  const request = new Request('https://essay.example.com/api/grade', {
    headers: {
      'user-agent': 'test-agent',
      referer: 'https://essay.example.com/'
    }
  });
  const id = await logEvent({ DB: db }, request, {
    eventType: 'ai_request',
    ip: '203.0.113.5',
    content: { essay: 'hello' },
    meta: { colo: 'HKG' }
  });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(db.calls.length, 1);
  const args = db.calls[0].args;
  assert.equal(args[2], '203.0.113.5');
  assert.equal(args[3], 'test-agent');
  assert.equal(args[4], 'https://essay.example.com/');
  assert.equal(args[6], 'ai_request');
  assert.deepEqual(JSON.parse(args[7]), { essay: 'hello' });
  assert.deepEqual(JSON.parse(args[11]), { colo: 'HKG' });
});

test('logEventSafe swallows a database failure', async () => {
  const env = {
    DB: {
      prepare() {
        return { bind() { return { run: async () => { throw new Error('db down'); } }; } };
      }
    }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await logEventSafe(env, null, { eventType: 'ai_error', ip: 'unknown' });
    assert.equal(result, null);
  } finally {
    console.error = originalError;
  }
});

test('listLogs rejects invalid filters before touching D1', async () => {
  const env = {};
  await assert.rejects(listLogs(env, { type: 'made_up' }), (error) => error.code === 'invalid_event_type');
  await assert.rejects(listLogs(env, { ip: 'not-an-ip' }), (error) => error.code === 'invalid_ip');
  await assert.rejects(listLogs(env, { range: '5m' }), (error) => error.code === 'invalid_range');
});

test('getStats rejects an invalid range before touching D1', async () => {
  await assert.rejects(getStats({}, '5m'), (error) => error.code === 'invalid_range');
});

test('getLog parses stored JSON content', async () => {
  const row = {
    id: 'log-1',
    event_type: 'ai_result',
    content: JSON.stringify({ report: { overall_score: 12 } }),
    meta: JSON.stringify({ colo: 'HKG' })
  };
  const log = await getLog({ DB: recordingDb(row) }, 'log-1');
  assert.deepEqual(log.content, { report: { overall_score: 12 } });
  assert.deepEqual(log.meta, { colo: 'HKG' });
});
