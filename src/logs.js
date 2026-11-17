import { cleanText, HttpError, isoNow, isValidIp, parseJsonOrText } from './http.js';

export const EVENT_TYPES = Object.freeze([
  'ai_request',
  'ai_result',
  'ai_error',
  'ai_invalid_output',
  'validation_error',
  'rate_limited',
  'idempotency_conflict',
  'job_read',
  'admin_login_ok',
  'admin_login_failed',
  'admin_unauthorized',
  'admin_view',
  'admin_cleanup',
  'cron_cleanup',
  'cron_error'
]);

const EVENT_SET = new Set(EVENT_TYPES);
const RANGES = { '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };

function encodeContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return JSON.stringify({ text: content });
  return JSON.stringify(content);
}

export async function logEvent(env, request, entry) {
  const meta = entry.meta ? JSON.stringify(entry.meta) : null;
  const country = entry.country ?? (request?.cf?.country || null);
  const agent = cleanText(entry.userAgent ?? request?.headers?.get('user-agent') ?? '', 400);
  const ref = cleanText(entry.referer ?? request?.headers?.get('referer') ?? '', 500);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO request_logs
      (id, created_at, ip, user_agent, referer, country, event_type, content, http_status, duration_ms, job_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    entry.createdAt || isoNow(),
    entry.ip || 'unknown',
    agent,
    ref,
    country,
    entry.eventType,
    encodeContent(entry.content),
    entry.httpStatus ?? null,
    entry.durationMs ?? null,
    entry.jobId ?? null,
    meta
  ).run();
  return id;
}

export async function logEventSafe(env, request, entry) {
  try {
    return await logEvent(env, request, entry);
  } catch (error) {
    console.error('telemetry_write_failed', entry?.eventType || 'unknown', String(error?.message || error));
    return null;
  }
}

function sinceFor(range) {
  if (range === 'all') return null;
  const span = RANGES[range] || RANGES['24h'];
  return new Date(Date.now() - span).toISOString();
}

export async function listLogs(env, { limit = 50, offset = 0, type = '', ip = '', range = '24h' } = {}) {
  const size = Math.max(1, Math.min(100, Number(limit) || 50));
  const start = Math.max(0, Math.min(100_000, Number(offset) || 0));
  if (type && !EVENT_SET.has(type)) throw new HttpError('invalid_event_type', 400);
  if (ip && !isValidIp(ip)) throw new HttpError('invalid_ip', 400);
  if (range && range !== 'all' && !RANGES[range]) throw new HttpError('invalid_range', 400);

  const where = [];
  const params = [];
  if (type) { where.push('event_type = ?'); params.push(type); }
  if (ip) { where.push('ip = ?'); params.push(ip); }
  const since = sinceFor(range);
  if (since) { where.push('created_at >= ?'); params.push(since); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countResult, rowsResult] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM request_logs ${clause}`).bind(...params),
    env.DB.prepare(
      `SELECT id, created_at, ip, user_agent, referer, country, event_type,
              substr(content, 1, 500) AS content_preview, http_status, duration_ms, job_id, meta
         FROM request_logs ${clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
    ).bind(...params, size, start)
  ]);

  return {
    items: rowsResult?.results || [],
    total: Number(countResult?.results?.[0]?.n) || 0,
    limit: size,
    offset: start
  };
}

export async function getLog(env, id) {
  const row = await env.DB.prepare('SELECT * FROM request_logs WHERE id = ?').bind(id).first();
  if (!row) return null;
  return {
    ...row,
    content: parseJsonOrText(row.content),
    meta: parseJsonOrText(row.meta)
  };
}

export async function getStats(env, range = '24h') {
  if (range !== 'all' && !RANGES[range]) throw new HttpError('invalid_range', 400);
  const since = sinceFor(range) || new Date(0).toISOString();
  const last24h = new Date(Date.now() - RANGES['24h']).toISOString();

  const results = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE created_at >= ?').bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_request' AND created_at >= ?").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_result' AND created_at >= ?").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type IN ('ai_error','ai_invalid_output') AND created_at >= ?").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'rate_limited' AND created_at >= ?").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'validation_error' AND created_at >= ?").bind(since),
    env.DB.prepare(
      `SELECT AVG(duration_ms) AS avg_ms FROM (
         SELECT duration_ms FROM request_logs
          WHERE event_type = 'ai_result' AND created_at >= ?
          ORDER BY created_at DESC LIMIT 200
       )`
    ).bind(since),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT ip) AS n FROM (
         SELECT ip FROM request_logs
          WHERE event_type = 'ai_request' AND created_at >= ?
          ORDER BY created_at DESC LIMIT 500
       )`
    ).bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'ai_request' AND created_at >= ?").bind(last24h)
  ]);

  const n = index => Number(results?.[index]?.results?.[0]?.n) || 0;
  const aiRequests = n(1);
  const aiResults = n(2);
  const average = results?.[6]?.results?.[0]?.avg_ms;
  return {
    range,
    total_logs: n(0),
    ai_requests: aiRequests,
    ai_results: aiResults,
    ai_errors: n(3),
    rate_limited: n(4),
    validation_errors: n(5),
    average_duration_ms: average == null ? null : Math.round(Number(average)),
    active_ips_sample: n(7),
    global_used_24h: n(8),
    success_rate: aiRequests > 0 ? Math.round((aiResults / aiRequests) * 100) : null
  };
}

export function maskIp(ip) {
  const value = String(ip || '');
  if (!value || value === 'unknown') return 'unknown';
  if (value.includes(':')) {
    const groups = value.split(':').filter(Boolean);
    return `${groups.slice(0, 4).join(':') || value.slice(0, 8)}:*`;
  }
  const parts = value.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return value;
}
