import {
  assertSameOrigin, clientIp, HttpError, isUuid, json, parseJsonOrText,
  readJson, requestMeta
} from './http.js';
import {
  extractJson, fingerprint, normalizeInput, normalizeReport, OutputError
} from './essay.js';
import { AiError, callAI, pickProvider } from './ai.js';
import { PROMPT_VERSION } from './prompts.js';
import {
  countRequests, getConfig, rateLimitDecision
} from './limits.js';
import { logEvent, logEventSafe } from './logs.js';
import { adminLogin, handleAdmin } from './admin.js';

const MESSAGES = {
  invalid_content_type: '请求格式不正确。',
  payload_too_large: '提交内容过长。',
  invalid_json: '提交内容不是有效 JSON。',
  invalid_encoding: '提交内容编码无效。',
  invalid_input: '提交内容不完整。',
  invalid_mode: '请选择批改或生成范文。',
  invalid_request_id: '请求标识无效，请刷新页面重试。',
  title_too_long: '题目过长。',
  requirements_too_long: '附加要求过长。',
  essay_too_long: '作文稿过长（最多 4000 字符 / 400 词）。',
  essay_too_short: '作文稿太短（至少 20 词）。',
  title_required: '生成范文需要先填写题目。',
  idempotency_conflict: '同一请求标识对应了不同内容，请刷新页面后重试。',
  rate_limited: '请求太频繁，请稍后再试。',
  ai_not_configured: '站点尚未配置 AI 服务。',
  ai_auth_failed: 'AI 服务鉴权失败，请联系管理员。',
  ai_rate_limited: 'AI 服务繁忙，请稍后再试。',
  ai_timeout: 'AI 响应超时，请重试或稍后在任务状态中取回结果。',
  ai_truncated: 'AI 输出被截断，请精简要求后重试。',
  ai_invalid_response: 'AI 返回异常，请重试。',
  ai_invalid_output: 'AI 返回格式异常，请重试。',
  ai_config_invalid: 'AI 接口配置不安全或无效，请联系管理员。',
  ai_upstream_error: 'AI 服务暂时不可用，请稍后重试。',
  telemetry_unavailable: '日志服务暂时不可用，请稍后重试。',
  admin_not_configured: '管理台未配置 ADMIN_TOKEN。',
  admin_unauthorized: '管理员口令错误。',
  admin_locked: '尝试次数过多，请稍后再试。',
  cross_origin_rejected: '跨站请求被拒绝。',
  not_found: '接口不存在。',
  method_not_allowed: '请求方法不允许。',
  invalid_event_type: '日志类型无效。',
  invalid_ip: 'IP 格式无效。',
  invalid_range: '时间范围无效。',
  invalid_settings: '设置数值超出范围。',
  stale_job: '这次任务已超时，请重新提交。',
  job_result_missing: '任务结果丢失，请重新提交。',
  server_error: '服务暂时不可用，请稍后重试。'
};

function methodNotAllowed() {
  return new HttpError('method_not_allowed', 405);
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return json(
      { ok: false, code: error.code, message: MESSAGES[error.code] || '请求失败。', ...(error.extra || {}) },
      error.status,
      error.headers || {}
    );
  }
  if (error instanceof AiError) {
    return json(
      { ok: false, code: error.code, message: MESSAGES[error.code] || 'AI 服务暂时不可用。' },
      error.status
    );
  }
  if (error instanceof OutputError) {
    return json(
      { ok: false, code: 'ai_invalid_output', message: MESSAGES.ai_invalid_output },
      502
    );
  }
  console.error('unhandled_error', String(error?.message || error));
  return json(
    { ok: false, code: 'server_error', message: MESSAGES.server_error },
    500
  );
}

function health(env) {
  const provider = pickProvider(env);
  return json({
    ok: true,
    mode: String(env.DEV_FIXTURE || '').toLowerCase() === 'true' ? 'fixture' : 'live',
    provider: provider.kind,
    model: provider.model,
    aiConfigured: provider.kind !== 'none',
    promptVersion: PROMPT_VERSION
  });
}

function jobRowSelect() {
  return `SELECT id, status, result, error_code, model, fingerprint, updated_at, created_at
            FROM grading_jobs WHERE id = ?`;
}

async function failJob(env, id, code, durationMs = null) {
  try {
    await env.DB.prepare(
      "UPDATE grading_jobs SET updated_at = ?, status = 'failed', error_code = ?, duration_ms = ? WHERE id = ?"
    ).bind(new Date().toISOString(), code, durationMs, id).run();
  } catch (error) {
    console.error('job_fail_update_failed', String(error?.message || error));
  }
}

async function completeJob(env, id, report, model, durationMs) {
  try {
    await env.DB.prepare(
      `UPDATE grading_jobs
          SET updated_at = ?, status = 'completed', result = ?, error_code = NULL,
              model = ?, duration_ms = ?
        WHERE id = ?`
    ).bind(new Date().toISOString(), JSON.stringify(report), model, durationMs, id).run();
  } catch (error) {
    console.error('job_complete_update_failed', String(error?.message || error));
  }
}

function completedResponse(job) {
  const result = parseJsonOrText(job.result);
  if (!result || typeof result !== 'object') {
    return json({ ok: false, code: 'job_result_missing', status: 'failed', jobId: job.id }, 500);
  }
  return json({ ok: true, status: 'completed', jobId: job.id, result });
}

function storedJobResponse(job) {
  if (job.status === 'completed') return completedResponse(job);
  if (job.status === 'running') {
    return json({ ok: true, status: 'running', jobId: job.id }, 202);
  }
  return json({
    ok: false,
    code: job.error_code || 'ai_upstream_error',
    status: 'failed',
    jobId: job.id
  }, 200);
}

function isStale(job) {
  const updated = Date.parse(job.updated_at);
  return Number.isFinite(updated) && Date.now() - updated > 180_000;
}

async function grade(request, env) {
  assertSameOrigin(request);
  const ip = clientIp(request);
  const meta = requestMeta(request);

  let body;
  try {
    body = await readJson(request, 32768);
  } catch (error) {
    if (error instanceof HttpError) {
      await logEventSafe(env, request, {
        eventType: 'validation_error', ip, meta,
        content: { code: error.code, raw: error.rawText || null },
        httpStatus: error.status
      });
    }
    throw error;
  }

  let input;
  try {
    input = normalizeInput(body);
  } catch (error) {
    await logEventSafe(env, request, {
      eventType: 'validation_error', ip, meta,
      content: { code: error.code, body },
      httpStatus: error.status
    });
    throw error;
  }

  const start = Date.now();
  const requestId = input.requestId;
  const fp = await fingerprint(input);
  const existing = await env.DB.prepare(jobRowSelect()).bind(requestId).first();

  if (existing) {
    if (existing.fingerprint !== fp) {
      await logEventSafe(env, request, {
        eventType: 'idempotency_conflict', ip, meta, jobId: requestId,
        content: input, httpStatus: 409
      });
      throw new HttpError('idempotency_conflict', 409);
    }
    if (existing.status === 'running' && isStale(existing)) {
      await failJob(env, requestId, 'stale_job');
      return json({ ok: false, code: 'stale_job', status: 'failed', jobId: requestId }, 200);
    }
    return storedJobResponse(existing);
  }

  const config = await getConfig(env);
  const counts = await countRequests(
    env,
    ip,
    new Date(start - 3_600_000).toISOString(),
    new Date(start - 86_400_000).toISOString()
  );
  const decision = rateLimitDecision(counts, config);
  if (!decision.allowed) {
    await logEventSafe(env, request, {
      eventType: 'rate_limited', ip, meta,
      content: { ...input, counts, limits: config, scope: decision.scope },
      httpStatus: 429
    });
    return json({
      ok: false,
      code: 'rate_limited',
      message: '请求太频繁，请稍后再试。',
      scope: decision.scope,
      retryAfterSeconds: decision.retryAfterSeconds
    }, 429, { 'retry-after': String(decision.retryAfterSeconds) });
  }

  const provider = pickProvider(env);
  if (provider.kind === 'none') {
    await logEventSafe(env, request, {
      eventType: 'ai_error', ip, meta, jobId: requestId,
      content: { code: 'ai_not_configured', input: input },
      httpStatus: 503
    });
    throw new HttpError('ai_not_configured', 503);
  }

  const nowIso = new Date(start).toISOString();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO grading_jobs
      (id, created_at, updated_at, ip, fingerprint, mode, title, essay, requirements, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`
  ).bind(
    requestId, nowIso, nowIso, ip, fp, input.mode, input.title, input.essay, input.requirements
  ).run();

  if ((inserted?.meta?.changes || 0) === 0) {
    const raced = await env.DB.prepare(jobRowSelect()).bind(requestId).first();
    if (!raced) throw new HttpError('server_error', 500);
    if (raced.fingerprint !== fp) {
      await logEventSafe(env, request, {
        eventType: 'idempotency_conflict', ip, meta, jobId: requestId,
        content: input, httpStatus: 409
      });
      throw new HttpError('idempotency_conflict', 409);
    }
    return storedJobResponse(raced);
  }

  try {
    await logEvent(env, request, {
      eventType: 'ai_request', ip, meta, jobId: requestId,
      content: { ...input, provider: provider.kind, model: provider.model }
    });
  } catch (error) {
    await failJob(env, requestId, 'telemetry_unavailable');
    throw new HttpError('telemetry_unavailable', 503);
  }

  const timeoutSignal = AbortSignal.timeout(50_000);
  const signal = typeof AbortSignal.any === 'function'
    ? AbortSignal.any([timeoutSignal, request.signal])
    : timeoutSignal;

  let ai;
  try {
    ai = await callAI(env, input, { signal });
  } catch (error) {
    const code = error instanceof AiError ? error.code : 'ai_upstream_error';
    const status = error instanceof AiError ? error.status : 502;
    await failJob(env, requestId, code, Date.now() - start);
    await logEventSafe(env, request, {
      eventType: 'ai_error', ip, meta, jobId: requestId,
      content: {
        code,
        status,
        detail: String(error?.detail || error?.message || '').slice(0, 1500),
        provider: provider.kind,
        model: provider.model
      },
      httpStatus: status,
      durationMs: Date.now() - start
    });
    throw error;
  }

  let report;
  try {
    report = normalizeReport(extractJson(ai.text), input);
  } catch (error) {
    if (error instanceof OutputError) {
      await failJob(env, requestId, 'ai_invalid_output', Date.now() - start);
      await logEventSafe(env, request, {
        eventType: 'ai_invalid_output', ip, meta, jobId: requestId,
        content: {
          message: error.message,
          raw: String(ai.text || '').slice(0, 16_000),
          provider: ai.provider,
          model: ai.model
        },
        httpStatus: 502,
        durationMs: Date.now() - start
      });
    } else {
      await failJob(env, requestId, 'server_error', Date.now() - start);
      await logEventSafe(env, request, {
        eventType: 'ai_error', ip, meta, jobId: requestId,
        content: { code: 'server_error', message: String(error?.message || error).slice(0, 500) },
        httpStatus: 500,
        durationMs: Date.now() - start
      });
    }
    throw error;
  }

  report.provider = ai.provider;
  report.model = ai.model;
  report.prompt_version = PROMPT_VERSION;
  const duration = Date.now() - start;
  await completeJob(env, requestId, report, ai.model, duration);
  await logEventSafe(env, request, {
    eventType: 'ai_result', ip, meta, jobId: requestId,
    content: { report, usage: ai.usage, provider: ai.provider, model: ai.model },
    httpStatus: 200,
    durationMs: duration
  });

  return json({
    ok: true,
    status: 'completed',
    jobId: requestId,
    result: report,
    provider: ai.provider,
    model: ai.model
  });
}

async function jobStatus(request, env, id) {
  const job = await env.DB.prepare(jobRowSelect()).bind(id).first();
  if (!job) throw new HttpError('not_found', 404);
  if (job.status === 'running' && isStale(job)) {
    await failJob(env, id, 'stale_job');
    await logEventSafe(env, request, {
      eventType: 'job_read', ip: clientIp(request), meta: requestMeta(request), jobId: id,
      content: { status: 'failed', errorCode: 'stale_job' }
    });
    return json({ ok: false, code: 'stale_job', status: 'failed', jobId: id }, 200);
  }
  await logEventSafe(env, request, {
    eventType: 'job_read', ip: clientIp(request), meta: requestMeta(request), jobId: id,
    content: { status: job.status, errorCode: job.error_code || null }
  });
  return storedJobResponse(job);
}

export async function handleRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return await env.ASSETS.fetch(request);
      }
      throw new HttpError('not_found', 404);
    }

    if (path === '/api/health') {
      if (request.method !== 'GET') throw methodNotAllowed();
      return health(env);
    }

    if (path === '/api/grade') {
      if (request.method !== 'POST') throw methodNotAllowed();
      return await grade(request, env);
    }

    const job = path.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (job && isUuid(job[1])) {
      if (request.method !== 'GET') throw methodNotAllowed();
      return await jobStatus(request, env, job[1]);
    }

    if (path === '/api/admin/login') {
      if (request.method !== 'POST') throw methodNotAllowed();
      return await adminLogin(request, env);
    }

    if (path.startsWith('/api/admin/')) {
      return await handleAdmin(request, env, url, ctx);
    }

    throw new HttpError('not_found', 404);
  } catch (error) {
    return errorResponse(error);
  }
}
