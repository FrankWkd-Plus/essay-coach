import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONFIG, normalizeConfig, rateLimitDecision, validateSettingsInput
} from '../src/limits.js';

test('normalizeConfig clamps valid integers and falls back for non-integers', () => {
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), { ...DEFAULT_CONFIG });
  assert.deepEqual(normalizeConfig({
    hourlyPerIp: 0,
    dailyPerIp: 999,
    globalDaily: 0,
    retentionDays: 999,
    lastCleanupAt: '2026-01-01T00:00:00.000Z'
  }), {
    hourlyPerIp: 1,
    dailyPerIp: 500,
    globalDaily: 10,
    retentionDays: 365,
    lastCleanupAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(normalizeConfig({ hourlyPerIp: 1.5 }).hourlyPerIp, DEFAULT_CONFIG.hourlyPerIp);
  assert.equal(normalizeConfig({ lastCleanupAt: 123 }).lastCleanupAt, null);
});

test('validateSettingsInput accepts in-range fields and rejects bad input', () => {
  assert.deepEqual(validateSettingsInput({ hourlyPerIp: 5, retentionDays: 14 }), {
    hourlyPerIp: 5,
    retentionDays: 14
  });
  assert.throws(() => validateSettingsInput({}), (error) => error.code === 'invalid_settings');
  assert.throws(() => validateSettingsInput({ hourlyPerIp: 0 }), (error) => error.code === 'invalid_settings');
  assert.throws(() => validateSettingsInput({ globalDaily: 5 }), (error) => error.code === 'invalid_settings');
  assert.throws(() => validateSettingsInput({ retentionDays: 366 }), (error) => error.code === 'invalid_settings');
  assert.throws(() => validateSettingsInput({ hourlyPerIp: '5' }), (error) => error.code === 'invalid_settings');
  assert.throws(() => validateSettingsInput([]), (error) => error.code === 'invalid_settings');
});

test('rateLimitDecision blocks at the configured boundary', () => {
  const config = { hourlyPerIp: 10, dailyPerIp: 30, globalDaily: 100 };
  assert.deepEqual(rateLimitDecision({ hourly: 9, daily: 0, global: 0 }, config), { allowed: true });
  assert.equal(rateLimitDecision({ hourly: 10, daily: 0, global: 0 }, config).scope, 'hourly');
  assert.equal(rateLimitDecision({ hourly: 0, daily: 30, global: 0 }, config).scope, 'daily');
  assert.equal(rateLimitDecision({ hourly: 0, daily: 0, global: 100 }, config).scope, 'global');
});

test('retryAfterSeconds is present for each blocked scope', () => {
  const config = { hourlyPerIp: 1, dailyPerIp: 1, globalDaily: 10 };
  assert.equal(rateLimitDecision({ hourly: 1, daily: 0, global: 0 }, config).retryAfterSeconds, 600);
  assert.equal(rateLimitDecision({ hourly: 0, daily: 1, global: 0 }, config).retryAfterSeconds, 3600);
  assert.equal(rateLimitDecision({ hourly: 0, daily: 0, global: 10 }, config).retryAfterSeconds, 3600);
});
