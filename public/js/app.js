import { ApiError, api } from './api.js';
import { renderReport } from './report.js';
import { SAMPLE } from './sample.js';
import { enterAdmin, initAdmin } from './admin.js';

const STORAGE_KEY = 'essayCoach.history.v1';
const LOADING_STEPS = [
  '正在读懂题目……',
  '正在检查结构与词数……',
  '正在逐句寻找可改之处……',
  '正在对照三段式风格清单……',
  '正在写升级版……'
];

const $ = (id) => document.getElementById(id);

const els = {
  gradeView: $('grade-view'),
  adminView: $('admin-view'),
  fixtureBanner: $('fixture-banner'),
  providerBadge: $('provider-badge'),
  footerProvider: $('footer-provider'),
  privacyButton: $('privacy-button'),
  privacyDialog: $('privacy-dialog'),
  closePrivacy: $('close-privacy'),
  closePrivacyBottom: $('close-privacy-bottom'),
  tabGrade: $('tab-grade'),
  tabGenerate: $('tab-generate'),
  essayForm: $('essay-form'),
  titleInput: $('title-input'),
  essayBlock: $('essay-block'),
  essayInput: $('essay-input'),
  wordCounter: $('word-counter'),
  fileInput: $('file-input'),
  sampleButton: $('sample-button'),
  requirementsInput: $('requirements-input'),
  submitButton: $('submit-button'),
  cancelButton: $('cancel-button'),
  formStatus: $('form-status'),
  statusText: $('status-text'),
  statusAction: $('status-action'),
  historySection: $('history-section'),
  historyList: $('history-list'),
  clearHistory: $('clear-history'),
  emptyState: $('empty-state'),
  loadingState: $('loading-state'),
  loadingDetail: $('loading-detail'),
  loadingElapsed: $('loading-elapsed'),
  report: $('report'),
  resultModeBadge: $('result-mode-badge'),
  toast: $('toast')
};

const state = {
  mode: 'grade',
  busy: false,
  controller: null,
  cancelled: false,
  pendingJobId: null,
  health: null,
  history: [],
  lastPayload: null,
  statusAction: null,
  loadingStepTimer: null,
  loadingClock: null,
  toastTimer: null
};

function countWords(text) {
  const value = String(text || '');
  const words = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [];
  return words.length + cjk.length;
}

function formatScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2800);
}

function setStatus(message, tone = 'info', action = null) {
  state.statusAction = action;
  els.formStatus.hidden = !message;
  els.formStatus.className = 'status' + (tone === 'error' ? ' is-error' : tone === 'success' ? ' is-success' : '');
  els.statusText.textContent = message || '';
  if (action) {
    els.statusAction.hidden = false;
    els.statusAction.onclick = () => {
      const handler = state.statusAction;
      if (handler) handler();
    };
  } else {
    els.statusAction.hidden = true;
    els.statusAction.onclick = null;
  }
}

function updateWordCount() {
  const words = countWords(els.essayInput.value);
  els.wordCounter.textContent = `${words} 词 · 目标 100–140`;
  els.wordCounter.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (words >= 100 && words <= 140) els.wordCounter.classList.add('is-ok');
  else if (words >= 80 && words <= 160) els.wordCounter.classList.add('is-warn');
  else els.wordCounter.classList.add('is-bad');
}

function updateSubmitLabel() {
  if (state.busy) {
    els.submitButton.textContent = '处理中……';
    return;
  }
  els.submitButton.textContent = state.mode === 'grade' ? '开始批改' : '生成范文';
}

function setMode(mode) {
  state.mode = mode;
  const isGrade = mode === 'grade';
  els.tabGrade.classList.toggle('is-active', isGrade);
  els.tabGenerate.classList.toggle('is-active', !isGrade);
  els.tabGrade.setAttribute('aria-selected', String(isGrade));
  els.tabGenerate.setAttribute('aria-selected', String(!isGrade));
  els.essayBlock.hidden = !isGrade;
  els.titleInput.placeholder = isGrade
    ? '例如：A Change in My Life'
    : '例如：A Memorable School Activity';
  updateSubmitLabel();
  updateWordCount();
}

function setBusy(busy) {
  state.busy = busy;
  els.submitButton.disabled = busy || state.health?.aiConfigured === false;
  els.cancelButton.hidden = !busy;
  els.tabGrade.disabled = busy;
  els.tabGenerate.disabled = busy;
  updateSubmitLabel();
}

function startLoading() {
  els.emptyState.hidden = true;
  els.report.hidden = true;
  els.loadingState.hidden = false;
  els.resultModeBadge.hidden = true;
  let step = 0;
  els.loadingDetail.textContent = LOADING_STEPS[0];
  const started = Date.now();
  els.loadingElapsed.textContent = '已等待 0 秒';
  clearInterval(state.loadingStepTimer);
  clearInterval(state.loadingClock);
  state.loadingStepTimer = setInterval(() => {
    step = (step + 1) % LOADING_STEPS.length;
    els.loadingDetail.textContent = LOADING_STEPS[step];
  }, 5000);
  state.loadingClock = setInterval(() => {
    els.loadingElapsed.textContent = `已等待 ${Math.round((Date.now() - started) / 1000)} 秒`;
  }, 1000);
}

function stopLoading() {
  clearInterval(state.loadingStepTimer);
  clearInterval(state.loadingClock);
  state.loadingStepTimer = null;
  state.loadingClock = null;
  els.loadingState.hidden = true;
}

function showEmpty() {
  stopLoading();
  els.emptyState.hidden = false;
  els.report.hidden = true;
  els.resultModeBadge.hidden = true;
}

function saveHistory(report, meta) {
  try {
    const payload = state.lastPayload || {};
    const entry = {
      id: uuid(),
      at: new Date().toISOString(),
      mode: report.mode,
      title: meta.title || '未命名作文',
      score: report.overall_score ?? null,
      wordCount: report.word_count ?? report.essay_word_count ?? null,
      input: {
        mode: payload.mode || report.mode,
        title: payload.title || '',
        essay: payload.essay || '',
        requirements: payload.requirements || ''
      },
      report,
      meta
    };
    state.history = [entry, ...state.history].slice(0, 8);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history));
    renderHistory();
  } catch {
    // Local history is a convenience; storage limits must not break grading.
  }
}

function renderHistory() {
  els.historyList.replaceChildren();
  if (!state.history.length) {
    els.historySection.hidden = true;
    return;
  }
  els.historySection.hidden = false;
  for (const entry of state.history) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = entry.title || '未命名作文';
    const score = document.createElement('span');
    score.className = 'history-score';
    score.textContent = entry.score == null ? '范文' : `${formatScore(entry.score)} / 15`;
    button.append(title, score);
    button.addEventListener('click', () => {
      if (state.busy) return;
      const input = entry.input || {};
      setMode(input.mode === 'generate' ? 'generate' : 'grade');
      els.titleInput.value = input.title || '';
      els.essayInput.value = input.essay || '';
      els.requirementsInput.value = input.requirements || '';
      updateWordCount();
      state.lastPayload = input;
      finishReport(entry.report, entry.meta || { title: entry.title, submittedAt: entry.at }, { save: false });
      toast('已恢复本地记录。');
    });
    els.historyList.append(button);
  }
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(parsed)) {
      state.history = parsed
        .filter(entry => entry && entry.report && entry.input)
        .slice(0, 8);
    }
  } catch {
    state.history = [];
  }
  renderHistory();
}

function finishReport(report, meta, { save = true } = {}) {
  stopLoading();
  els.emptyState.hidden = true;
  els.report.hidden = false;
  els.resultModeBadge.hidden = false;
  if (report.mode === 'generate') {
    els.resultModeBadge.textContent = '范文';
    els.resultModeBadge.className = 'badge';
  } else {
    els.resultModeBadge.textContent = `${formatScore(report.overall_score)} / 15`;
    els.resultModeBadge.className = 'badge is-live';
  }
  renderReport(els.report, report, meta, { onToast: toast });
  if (save) saveHistory(report, meta);

  if (report.mode === 'generate') {
    setStatus(`范文已生成，共 ${report.essay_word_count} 词。`, 'success');
  } else {
    setStatus(`批改完成：${formatScore(report.overall_score)} / 15（${report.band}）。`, 'success');
  }

  state.pendingJobId = null;
  if (window.matchMedia('(max-width: 980px)').matches) {
    els.report.closest('.result-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function validateInput(payload) {
  if (payload.title.length > 300) return '题目过长。';
  if (payload.requirements.length > 500) return '额外要求过长。';
  if (payload.mode === 'generate') {
    if (payload.title.length < 3) return '生成范文需要先填写至少 3 个字符的题目。';
    return '';
  }
  const words = countWords(payload.essay);
  if (payload.essay.length < 40 || words < 20) return '作文稿太短，请至少写 20 个词。';
  if (payload.essay.length > 4000 || words > 400) return '作文稿过长，请控制在 400 词以内。';
  return '';
}

function handleError(error) {
  showEmpty();
  if (error instanceof ApiError) {
    let message = error.message || '请求失败，请稍后重试。';
    if (error.code === 'rate_limited') {
      const seconds = Number(error.body?.retryAfterSeconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        message += `（约 ${Math.max(1, Math.ceil(seconds / 60))} 分钟后可再试）`;
      }
    }
    if (error.code === 'ai_not_configured') {
      message = '站点尚未配置 AI 服务，暂时无法批改。';
    }
    setStatus(message, 'error');
  } else {
    setStatus('请求失败，请稍后重试。', 'error');
  }
}

async function pollJob(id) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (state.cancelled) {
      showEmpty();
      setStatus('已取消。服务端可能已完成本次批改并计入额度。', 'error');
      return;
    }
    await sleep(2500);
    let result;
    try {
      result = await api.job(id, AbortSignal.timeout(15_000));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') {
        throw new ApiError('job_not_found', '未找到这次任务，可能提交没有成功，请重新提交。');
      }
      if (error instanceof ApiError && error.status >= 500) {
        setStatus('查询任务失败，正在重试……', 'info');
        continue;
      }
      throw error;
    }
    if (result.status === 'completed' && result.result) {
      const payload = state.lastPayload || {};
      finishReport(result.result, {
        title: payload.title || '',
        submittedAt: new Date().toISOString(),
        provider: result.result.provider || result.provider,
        model: result.result.model || result.model
      });
      return;
    }
    if (result.status === 'running') {
      setStatus(`AI 正在批改，已等待 ${Math.round((Date.now() - started) / 1000)} 秒……`, 'info');
      continue;
    }
  }
  state.pendingJobId = id;
  setStatus('任务仍在处理中，可稍后点击“查询结果”。', 'error', () => retryPendingJob(id));
}

async function retryPendingJob(id) {
  if (state.busy) return;
  setBusy(true);
  startLoading();
  setStatus('正在查询任务结果……', 'info');
  try {
    await pollJob(id);
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.busy) return;

  const payload = {
    mode: state.mode,
    title: els.titleInput.value.trim(),
    essay: els.essayInput.value.trim(),
    requirements: els.requirementsInput.value.trim()
  };
  const invalid = validateInput(payload);
  if (invalid) {
    setStatus(invalid, 'error');
    return;
  }

  state.lastPayload = payload;
  state.cancelled = false;
  const requestId = uuid();
  state.pendingJobId = requestId;
  setStatus('正在提交……', 'info');
  startLoading();
  setBusy(true);

  const controller = new AbortController();
  state.controller = controller;
  const timeout = setTimeout(() => controller.abort('timeout'), 65_000);

  try {
    const response = await api.grade(payload, requestId, controller.signal);
    clearTimeout(timeout);
    if (response.status === 'completed' && response.result) {
      finishReport(response.result, {
        title: payload.title,
        submittedAt: new Date().toISOString(),
        provider: response.provider,
        model: response.model
      });
    } else if (response.status === 'running') {
      await pollJob(requestId);
    } else {
      throw new ApiError('invalid_response', '服务器返回了意外的结果。');
    }
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      if (state.cancelled) {
        showEmpty();
        setStatus('已取消。服务端可能已完成本次批改并计入额度。', 'error');
      } else {
        setStatus('请求超时，正在查询任务结果……', 'info');
        await pollJob(requestId).catch(handleError);
      }
    } else if (error instanceof ApiError && error.code === 'network_error') {
      setStatus('网络中断，正在查询任务结果……', 'info');
      await pollJob(requestId).catch(handleError);
    } else {
      handleError(error);
    }
  } finally {
    clearTimeout(timeout);
    state.controller = null;
    setBusy(false);
  }
}

async function handleFile() {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = '';
  if (!file) return;
  if (file.size > 64 * 1024) {
    setStatus('文件太大，请上传 64KB 以内的 .txt 或 .md。', 'error');
    return;
  }
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '').trim();
    if (!text) {
      setStatus('文件是空的。', 'error');
      return;
    }
    if (text.length > 4000) {
      setStatus('文件内容超过 4000 字符，请精简后再上传。', 'error');
      return;
    }
    els.essayInput.value = text;
    updateWordCount();
    setStatus(`已载入 ${countWords(text)} 词的作文稿。`, 'success');
  } catch {
    setStatus('读取文件失败，请重试。', 'error');
  }
}

function fillSample() {
  setMode('grade');
  els.titleInput.value = SAMPLE.title;
  els.essayInput.value = SAMPLE.essay;
  els.requirementsInput.value = '';
  updateWordCount();
  setStatus('示例已填入，可以直接提交。', 'success');
}

async function loadHealth() {
  try {
    const health = await api.health();
    state.health = health;
    els.providerBadge.hidden = false;
    const labels = {
      external: '外部模型',
      'workers-ai': '内置模型',
      fixture: '本地演示',
      none: 'AI 未配置'
    };
    els.providerBadge.textContent = labels[health.provider] || 'AI 状态未知';
    els.providerBadge.className = 'badge ' + (
      health.provider === 'none' ? 'is-bad' : health.provider === 'fixture' ? 'is-warn' : 'is-live'
    );
    els.footerProvider.textContent = health.aiConfigured
      ? `模型：${health.model}`
      : 'AI 服务未配置';
    if (health.mode === 'fixture') els.fixtureBanner.hidden = false;
    if (!health.aiConfigured) {
      els.submitButton.disabled = true;
      setStatus('站点尚未配置 AI 服务，暂时无法批改。', 'error');
    }
  } catch {
    els.providerBadge.hidden = false;
    els.providerBadge.textContent = 'AI 状态未知';
    els.providerBadge.className = 'badge is-warn';
  }
}

function route() {
  const isAdmin = window.location.hash === '#/admin';
  els.gradeView.hidden = isAdmin;
  els.adminView.hidden = !isAdmin;
  document.title = isAdmin ? '管理台 · Essay Coach' : 'Essay Coach · 中考英语作文批改';
  if (isAdmin) enterAdmin();
}

function init() {
  initAdmin();
  els.tabGrade.addEventListener('click', () => { if (!state.busy) setMode('grade'); });
  els.tabGenerate.addEventListener('click', () => { if (!state.busy) setMode('generate'); });
  els.essayForm.addEventListener('submit', handleSubmit);
  els.essayInput.addEventListener('input', updateWordCount);
  els.fileInput.addEventListener('change', handleFile);
  els.sampleButton.addEventListener('click', fillSample);
  els.cancelButton.addEventListener('click', () => {
    state.cancelled = true;
    state.controller?.abort();
    setStatus('正在取消……', 'info');
  });
  els.privacyButton.addEventListener('click', () => els.privacyDialog.showModal());
  els.closePrivacy.addEventListener('click', () => els.privacyDialog.close());
  els.closePrivacyBottom.addEventListener('click', () => els.privacyDialog.close());
  els.privacyDialog.addEventListener('click', (event) => {
    if (event.target === els.privacyDialog) els.privacyDialog.close();
  });
  els.clearHistory.addEventListener('click', () => {
    if (!window.confirm('清空本机的最近批改记录？服务端日志不会受影响。')) return;
    localStorage.removeItem(STORAGE_KEY);
    state.history = [];
    renderHistory();
    toast('已清空本地记录。');
  });

  loadHistory();
  setMode('grade');
  route();
  loadHealth();
  window.addEventListener('hashchange', route);
}

init();
