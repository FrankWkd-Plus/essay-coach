import { HttpError } from './http.js';

export const DEFAULT_CONFIG = Object.freeze({
  hourlyPerIp: 10,
  dailyPerIp: 30,
  globalDaily: 100,
  retentionDays: 30,
  lastCleanupAt: null
});

function integer(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function normalizeConfig(input = {}) {
  return {
    hourlyPerIp: integer(input.hourlyPerIp, DEFAULT_CONFIG.hourlyPerIp, 1, 100),
    dailyPerIp: integer(input.dailyPerIp, DEFAULT_CONFIG.dailyPerIp, 1, 500),
    globalDaily: integer(input.globalDaily, DEFAULT_CONFIG.globalDaily, 10, 5000),
    retentionDays: integer(input.retentionDays, DEFAULT_CONFIG.retentionDays, 1, 365),
    lastCleanupAt: typeof input.lastCleanupAt === 'string' ? input.lastCleanupAt : null
  };
}

export async function getConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'config'").first();
  if (!row) return normalizeConfig(DEFAULT_CONFIG);
  let parsed = {};
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = {};
  }
  return normalizeConfig({ ...DEFAULT_CONFIG, ...parsed });
}

export function validateSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError('invalid_settings', 400);
  }
  const output = {};
  const fields = [
    ['hourlyPerIp', 1, 100],
    ['dailyPerIp', 1, 500],
    ['globalDaily', 10, 5000],
    ['retentionDays', 1, 365]
  ];
  for (const [field, min, max] of fields) {
    if (!(field in input)) continue;
    const value = input[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new HttpError('invalid_settings', 400);
    }
    output[field] = value;
  }
  if (Object.keys(output).length === 0) throw new HttpError('invalid_settings', 400);
  return output;
}

export async function saveConfig(env, input) {
  const current = await getConfig(env);
  const merged = normalizeConfig({ ...current, ...input });
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(merged), now).run();
  return merged;
}

function rowCount(result) {
  return Number(result?.results?.[0]?.n) || 0;
}

export async function countRequests(env, ip, sinceHour, sinceDay) {
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_request' AND ip = ? AND created_at >= ?"
    ).bind(ip, sinceHour),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_request' AND ip = ? AND created_at >= ?"
    ).bind(ip, sinceDay),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_request' AND created_at >= ?"
    ).bind(sinceDay)
  ]);
  return {
    hourly: rowCount(results?.[0]),
    daily: rowCount(results?.[1]),
    global: rowCount(results?.[2])
  };
}

export function rateLimitDecision(counts, config) {
  if (counts.hourly >= config.hourlyPerIp) {
    return { allowed: false, scope: 'hourly', retryAfterSeconds: 600 };
  }
  if (counts.daily >= config.dailyPerIp) {
    return { allowed: false, scope: 'daily', retryAfterSeconds: 3600 };
  }
  if (counts.global >= config.globalDaily) {
    return { allowed: false, scope: 'global', retryAfterSeconds: 3600 };
  }
  return { allowed: true };
}
