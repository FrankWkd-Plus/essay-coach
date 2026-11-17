import {
  assertSameOrigin, cleanText, clientIp, HttpError, json, readJson, requestMeta
} from './http.js';
import { getLog, getStats, listLogs, logEventSafe } from './logs.js';
import { cleanup } from './cleanup.js';
import { getConfig, saveConfig, validateSettingsInput } from './limits.js';
import { pickProvider } from './ai.js';

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function adminConfigured(env) {
  return typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= 16;
}

export async function requireAdmin(request, env) {
  if (!adminConfigured(env)) throw new HttpError('admin_not_configured', 503);
  const provided = request.headers.get('x-admin-token') || '';
  if (!provided || provided.length > 256) throw new HttpError('admin_unauthorized', 401);
  if (!(await tokenMatches(provided, env.ADMIN_TOKEN))) {
    throw new HttpError('admin_unauthorized', 401);
  }
}

async function loginFailures(env, ip, since) {
  const [perIp, global] = await env.DB.batch([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'admin_login_failed' AND ip = ? AND created_at >= ?"
    ).bind(ip, since),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request_logs WHERE event_type = 'admin_login_failed' AND created_at >= ?"
    ).bind(since)
  ]);
  return {
    perIp: Number(perIp?.results?.[0]?.n) || 0,
    global: Number(global?.results?.[0]?.n) || 0
  };
}

export async function adminLogin(request, env) {
  assertSameOrigin(request);
  const ip = clientIp(request);
  const meta = requestMeta(request);
  const body = await readJson(request, 4096);
  const token = cleanText(body.token, 256);

  if (!adminConfigured(env)) {
    await logEventSafe(env, request, {
      eventType: 'admin_login_failed', ip, meta,
      content: { reason: 'not_configured' }, httpStatus: 503
    });
    throw new HttpError('admin_not_configured', 503);
  }

  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const failures = await loginFailures(env, ip, since);
  if (failures.perIp >= 5 || failures.global >= 50) {
    await logEventSafe(env, request, {
      eventType: 'admin_login_failed', ip, meta,
      content: { blocked: true, failures }, httpStatus: 429
    });
    return json({
      ok: false,
      code: 'admin_locked',
      message: '尝试次数过多，请 10 分钟后再试。'
    }, 429, { 'retry-after': '600' });
  }

  if (!token || !(await tokenMatches(token, env.ADMIN_TOKEN))) {
    await logEventSafe(env, request, {
      eventType: 'admin_login_failed', ip, meta,
      content: { reason: token ? 'wrong_token' : 'missing_token' }, httpStatus: 401
    });
    throw new HttpError('admin_unauthorized', 401);
  }

  await logEventSafe(env, request, {
    eventType: 'admin_login_ok', ip, meta, content: { success: true }, httpStatus: 200
  });
  return json({ ok: true });
}

function scheduleAdminView(ctx, env, request, content) {
  const entry = {
    eventType: 'admin_view',
    ip: clientIp(request),
    meta: requestMeta(request),
    content
  };
  if (ctx?.waitUntil) {
    ctx.waitUntil(logEventSafe(env, request, entry));
  } else {
    void logEventSafe(env, request, entry);
  }
}

export async function handleAdmin(request, env, url, ctx) {
  try {
    await requireAdmin(request, env);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'admin_unauthorized') {
      await logEventSafe(env, request, {
        eventType: 'admin_unauthorized',
        ip: clientIp(request),
        meta: requestMeta(request),
        content: { path: url.pathname },
        httpStatus: 401
      });
    }
    throw error;
  }

  const suffix = url.pathname.slice('/api/admin/'.length);
  const method = request.method;

  if (suffix === 'stats') {
    if (method !== 'GET') throw new HttpError('method_not_allowed', 405);
    const range = url.searchParams.get('range') || '24h';
    const [stats, config] = await Promise.all([getStats(env, range), getConfig(env)]);
    scheduleAdminView(ctx, env, request, { action: 'stats', range });
    return json({ ok: true, stats, config, provider: pickProvider(env) });
  }

  if (suffix === 'logs') {
    if (method !== 'GET') throw new HttpError('method_not_allowed', 405);
    const result = await listLogs(env, {
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      type: url.searchParams.get('type') || '',
      ip: url.searchParams.get('ip') || '',
      range: url.searchParams.get('range') || '24h'
    });
    scheduleAdminView(ctx, env, request, {
      action: 'logs',
      type: url.searchParams.get('type') || '',
      ip: url.searchParams.get('ip') || '',
      range: url.searchParams.get('range') || '24h'
    });
    return json({ ok: true, ...result });
  }

  const detail = suffix.match(/^logs\/([0-9a-f-]{36})$/i);
  if (detail) {
    if (method !== 'GET') throw new HttpError('method_not_allowed', 405);
    const log = await getLog(env, detail[1]);
    if (!log) throw new HttpError('not_found', 404);
    scheduleAdminView(ctx, env, request, { action: 'log_detail', logId: detail[1] });
    return json({ ok: true, log });
  }

  if (suffix === 'settings') {
    if (method === 'GET') {
      const config = await getConfig(env);
      scheduleAdminView(ctx, env, request, { action: 'settings_read' });
      return json({ ok: true, config });
    }
    if (method === 'POST') {
      const body = await readJson(request, 4096);
      const changes = validateSettingsInput(body);
      const before = await getConfig(env);
      const config = await saveConfig(env, changes);
      scheduleAdminView(ctx, env, request, {
        action: 'settings_update', before, after: config
      });
      return json({ ok: true, config });
    }
    throw new HttpError('method_not_allowed', 405);
  }

  if (suffix === 'cleanup') {
    if (method !== 'POST') throw new HttpError('method_not_allowed', 405);
    const body = await readJson(request, 4096);
    const days = body.days == null ? null : Number(body.days);
    if (days != null && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new HttpError('invalid_settings', 400);
    }
    const result = await cleanup(env, {
      manual: true,
      days,
      request,
      ctx
    });
    scheduleAdminView(ctx, env, request, { action: 'cleanup', ...result });
    return json({ ok: true, ...result });
  }

  throw new HttpError('not_found', 404);
}
