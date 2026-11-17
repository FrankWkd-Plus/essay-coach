import { clientIp, requestMeta } from './http.js';
import { logEventSafe } from './logs.js';
import { getConfig, saveConfig } from './limits.js';

export async function cleanup(env, {
  now = Date.now(), manual = false, days = null, request = null, ctx = null
} = {}) {
  const config = await getConfig(env);
  const retentionDays = days == null ? config.retentionDays : days;
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();

  const logs = await env.DB.prepare('DELETE FROM request_logs WHERE created_at < ?').bind(cutoff).run();
  const jobs = await env.DB.prepare(
    "DELETE FROM grading_jobs WHERE created_at < ? AND status != 'running'"
  ).bind(cutoff).run();

  const result = {
    retentionDays,
    cutoff,
    deletedLogs: Number(logs?.meta?.changes) || 0,
    deletedJobs: Number(jobs?.meta?.changes) || 0
  };

  try {
    await saveConfig(env, { lastCleanupAt: new Date(now).toISOString() });
  } catch (error) {
    console.error('cleanup_config_update_failed', String(error?.message || error));
  }

  await logEventSafe(env, request, {
    eventType: manual ? 'admin_cleanup' : 'cron_cleanup',
    ip: request ? clientIp(request) : 'cron',
    meta: request ? { ...requestMeta(request), trigger: 'manual' } : { trigger: 'cron', scheduledTime: now },
    content: result
  });

  return result;
}

export async function scheduledCleanup(controller, env) {
  try {
    await cleanup(env, {
      now: Number(controller?.scheduledTime) || Date.now(),
      manual: false
    });
  } catch (error) {
    await logEventSafe(env, null, {
      eventType: 'cron_error',
      ip: 'cron',
      content: { message: String(error?.message || error).slice(0, 500) }
    });
  }
}
