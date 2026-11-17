import { ApiError, api } from './api.js';

const TOKEN_KEY = 'essayCoach.adminToken';
const $ = (id) => document.getElementById(id);

const els = {
  state: $('admin-state'),
  logout: $('admin-logout'),
  loginForm: $('admin-login-form'),
  token: $('admin-token'),
  loginStatus: $('admin-login-status'),
  dashboard: $('admin-dashboard'),
  stats: $('admin-stats'),
  type: $('log-type'),
  ip: $('log-ip'),
  range: $('log-range'),
  mask: $('mask-ip'),
  refresh: $('refresh-logs'),
  logs: $('admin-logs'),
  pagination: $('admin-pagination'),
  settingsForm: $('settings-form'),
  hourly: $('setting-hourly'),
  daily: $('setting-daily'),
  global: $('setting-global'),
  retention: $('setting-retention'),
  cleanupDays: $('cleanup-days'),
  cleanup: $('cleanup-button'),
  dialog: $('log-dialog'),
  closeDialog: $('close-log-dialog'),
  detail: $('log-detail'),
  toast: $('toast')
};

const state = {
  token: '',
  offset: 0,
  limit: 50,
  total: 0,
  range: '24h',
  mask: true,
  busy: false,
  loginPending: false,
  cleanupTouched: false,
  toastTimer: null
};

let initialized = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function maskIp(value) {
  const ip = String(value || '');
  if (!state.mask || !ip || ip === 'unknown') return ip || 'unknown';
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return `${groups.slice(0, 4).join(':') || ip.slice(0, 8)}:*`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return ip;
}

function providerLabel(provider) {
  if (!provider) return '未知';
  if (provider.kind === 'external') return `外部模型 · ${provider.model || ''}`;
  if (provider.kind === 'workers-ai') return `内置模型 · ${provider.model || ''}`;
  if (provider.kind === 'fixture') return '本地演示';
  return '未配置';
}

function setLoginStatus(message, error = false) {
  els.loginStatus.textContent = message || '';
  els.loginStatus.style.color = error ? 'var(--danger)' : '';
}

function showLogin() {
  state.token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  els.dashboard.hidden = true;
  els.loginForm.hidden = false;
  els.state.textContent = '未登录';
  els.state.className = 'badge';
  els.logout.hidden = true;
}

function showDashboard() {
  els.loginForm.hidden = true;
  els.dashboard.hidden = false;
  els.state.textContent = '已登录';
  els.state.className = 'badge is-live';
  els.logout.hidden = false;
}

function handleError(error) {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    showLogin();
    setLoginStatus('口令已失效，请重新输入。', true);
    return;
  }
  if (error instanceof ApiError && error.code === 'admin_not_configured') {
    showLogin();
    setLoginStatus('站点尚未设置 ADMIN_TOKEN。请在 Cloudflare 控制台添加 Secret 后刷新。', true);
    return;
  }
  showToast(error?.message || '请求失败，请稍后重试。');
}

function request(path, options) {
  return api.admin(path, state.token, options);
}

function renderStats(stats, config, provider) {
  els.stats.replaceChildren();
  if (!stats) return;
  const cards = [
    ['请求总数', stats.total_logs, `${stats.range} 内全部日志`],
    ['AI 批改', stats.ai_requests, `成功 ${stats.ai_results} · ${providerLabel(provider)}`],
    ['成功率', stats.success_rate == null ? '—' : `${stats.success_rate}%`, '成功 / 请求'],
    ['AI 错误', stats.ai_errors, '含格式异常'],
    ['限流命中', stats.rate_limited, '429 次数'],
    ['平均耗时', stats.average_duration_ms == null ? '—' : `${stats.average_duration_ms} ms`, '近 200 条样本'],
    ['活跃 IP', stats.active_ips_sample, '近 500 次样本'],
    ['全站额度', `${stats.global_used_24h} / ${config?.globalDaily ?? '—'}`, '最近 24h']
  ];
  for (const [label, value, note] of cards) {
    const card = el('div', 'stat-card');
    card.append(el('span', 'stat-label', label));
    card.append(el('strong', 'stat-value', value));
    card.append(el('span', 'stat-note', note));
    els.stats.append(card);
  }
}

async function loadStats() {
  const response = await request(`stats?range=${encodeURIComponent(state.range)}`);
  renderStats(response.stats, response.config, response.provider);
  if (response.config && !state.cleanupTouched) {
    els.cleanupDays.value = String(response.config.retentionDays);
  }
}

async function loadSettings() {
  const response = await request('settings');
  const config = response.config;
  els.hourly.value = String(config.hourlyPerIp);
  els.daily.value = String(config.dailyPerIp);
  els.global.value = String(config.globalDaily);
  els.retention.value = String(config.retentionDays);
  if (!state.cleanupTouched) els.cleanupDays.value = String(config.retentionDays);
}

function toneFor(type) {
  if (!type) return '';
  if (type.includes('error') || type.includes('invalid') || type.includes('rate_limited') ||
      type.includes('unauthorized') || type.includes('failed')) return 'error';
  if (type.includes('result') || type.includes('ok') || type.includes('cleanup')) return 'ok';
  if (type.startsWith('admin')) return 'admin';
  return '';
}

function renderLogs(items) {
  els.logs.replaceChildren();
  if (!items || items.length === 0) {
    els.logs.append(el('div', 'log-empty', '没有符合条件的日志。'));
    return;
  }
  const table = el('table', 'log-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['时间', '类型', 'IP', '状态', '耗时', '内容预览']) {
    headRow.append(el('th', '', label));
  }
  thead.append(headRow);
  const tbody = el('tbody');
  for (const item of items) {
    const row = el('tr', 'log-row');
    row.tabIndex = 0;
    row.dataset.id = item.id;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `查看 ${item.event_type} 日志详情`);
    row.append(el('td', '', formatDate(item.created_at)));
    const type = el('td');
    const typeLabel = el('span', 'log-type', item.event_type || 'unknown');
    typeLabel.dataset.tone = toneFor(item.event_type);
    type.append(typeLabel);
    row.append(type);
    row.append(el('td', '', maskIp(item.ip)));
    row.append(el('td', '', item.http_status == null ? '—' : String(item.http_status)));
    row.append(el('td', '', item.duration_ms == null ? '—' : `${item.duration_ms} ms`));
    const preview = el('td', 'log-preview', item.content_preview || '');
    preview.title = item.content_preview || '';
    row.append(preview);
    row.addEventListener('click', () => openLog(item.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLog(item.id);
      }
    });
    tbody.append(row);
  }
  table.append(thead, tbody);
  els.logs.append(table);
}

function renderPagination(count) {
  els.pagination.replaceChildren();
  if (!state.total) {
    els.pagination.append(el('span', '', '0 条'));
    return;
  }
  const start = state.offset + 1;
  const end = state.offset + count;
  els.pagination.append(el('span', '', `${start}–${end} / ${state.total} 条`));
  const actions = el('div', 'pagination-actions');
  const previous = el('button', 'secondary-button', '上一页');
  previous.type = 'button';
  previous.disabled = state.offset <= 0;
  previous.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadLogs().catch(handleError);
  });
  const next = el('button', 'secondary-button', '下一页');
  next.type = 'button';
  next.disabled = state.offset + state.limit >= state.total;
  next.addEventListener('click', () => {
    state.offset += state.limit;
    loadLogs().catch(handleError);
  });
  actions.append(previous, next);
  els.pagination.append(actions);
}

async function loadLogs() {
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
    range: state.range
  });
  if (els.type.value) params.set('type', els.type.value);
  if (els.ip.value.trim()) params.set('ip', els.ip.value.trim());
  const response = await request(`logs?${params.toString()}`);
  state.total = response.total;
  renderLogs(response.items);
  renderPagination(response.items?.length || 0);
}

async function openLog(id) {
  try {
    const response = await request(`logs/${encodeURIComponent(id)}`);
    const log = response.log;
    const payload = {
      id: log.id,
      created_at: log.created_at,
      ip: maskIp(log.ip),
      user_agent: log.user_agent,
      referer: log.referer,
      country: log.country,
      event_type: log.event_type,
      http_status: log.http_status,
      duration_ms: log.duration_ms,
      job_id: log.job_id,
      meta: log.meta,
      content: log.content
    };
    els.detail.textContent = JSON.stringify(payload, null, 2);
    els.dialog.showModal();
  } catch (error) {
    handleError(error);
  }
}

async function loadAll() {
  if (!state.token || state.busy) return;
  state.busy = true;
  state.offset = 0;
  try {
    const results = await Promise.allSettled([loadStats(), loadSettings(), loadLogs()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) handleError(failure.reason);
  } finally {
    state.busy = false;
  }
}

async function login(event) {
  event.preventDefault();
  const token = els.token.value.trim();
  if (!token) {
    setLoginStatus('请输入管理员口令。', true);
    return;
  }
  const button = els.loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  state.loginPending = true;
  setLoginStatus('正在验证口令……');
  try {
    await api.adminLogin(token);
    state.token = token;
    sessionStorage.setItem(TOKEN_KEY, token);
    els.token.value = '';
    setLoginStatus('');
    showDashboard();
    await loadAll();
  } catch (error) {
    setLoginStatus(error instanceof ApiError ? error.message : '登录失败，请重试。', true);
  } finally {
    state.loginPending = false;
    button.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    hourlyPerIp: Number(els.hourly.value),
    dailyPerIp: Number(els.daily.value),
    globalDaily: Number(els.global.value),
    retentionDays: Number(els.retention.value)
  };
  if (!Number.isInteger(payload.hourlyPerIp) || payload.hourlyPerIp < 1 || payload.hourlyPerIp > 100 ||
      !Number.isInteger(payload.dailyPerIp) || payload.dailyPerIp < 1 || payload.dailyPerIp > 500 ||
      !Number.isInteger(payload.globalDaily) || payload.globalDaily < 10 || payload.globalDaily > 5000 ||
      !Number.isInteger(payload.retentionDays) || payload.retentionDays < 1 || payload.retentionDays > 365) {
    showToast('设置数值超出范围，请检查。');
    return;
  }
  try {
    const response = await request('settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    els.hourly.value = String(response.config.hourlyPerIp);
    els.daily.value = String(response.config.dailyPerIp);
    els.global.value = String(response.config.globalDaily);
    els.retention.value = String(response.config.retentionDays);
    if (!state.cleanupTouched) els.cleanupDays.value = String(response.config.retentionDays);
    showToast('设置已保存。');
    await loadStats();
  } catch (error) {
    handleError(error);
  }
}

async function runCleanup() {
  const days = Number(els.cleanupDays.value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    showToast('清理天数需在 1–365 之间。');
    return;
  }
  if (!window.confirm(`将删除早于 ${days} 天的日志和旧任务，且无法恢复。继续？`)) return;
  try {
    const response = await request('cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days })
    });
    showToast(`已清理 ${response.deletedLogs} 条日志、${response.deletedJobs} 个旧任务。`);
    await loadAll();
  } catch (error) {
    handleError(error);
  }
}

export function initAdmin() {
  if (initialized) return;
  initialized = true;
  state.token = sessionStorage.getItem(TOKEN_KEY) || '';

  els.loginForm.addEventListener('submit', login);
  els.logout.addEventListener('click', () => {
    showLogin();
    setLoginStatus('已退出。');
  });
  els.refresh.addEventListener('click', () => {
    loadAll().catch(handleError);
  });
  els.type.addEventListener('change', () => {
    state.offset = 0;
    loadLogs().catch(handleError);
  });
  els.range.addEventListener('change', () => {
    state.range = els.range.value;
    state.offset = 0;
    Promise.all([loadStats(), loadLogs()]).catch(handleError);
  });
  els.ip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.offset = 0;
      loadLogs().catch(handleError);
    }
  });
  els.mask.addEventListener('change', () => {
    state.mask = els.mask.checked;
    loadLogs().catch(handleError);
  });
  els.settingsForm.addEventListener('submit', saveSettings);
  els.cleanup.addEventListener('click', runCleanup);
  els.cleanupDays.addEventListener('input', () => { state.cleanupTouched = true; });
  els.closeDialog.addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('click', (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });

  if (state.token) showDashboard();
  else showLogin();
}

export function enterAdmin() {
  if (!state.token) {
    showLogin();
    return;
  }
  showDashboard();
  if (!state.loginPending) loadAll().catch(handleError);
}
