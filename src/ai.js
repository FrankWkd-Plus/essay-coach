import { buildMessages } from './prompts.js';
import { STYLE_ITEMS } from './essay.js';

export const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_EXTERNAL_MODEL = 'deepseek-chat';
export const DEFAULT_WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_TIMEOUT_MS = 50_000;

export class AiError extends Error {
  constructor(code, status = 502, detail = '') {
    super(code);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function pickProvider(env) {
  if (String(env.DEV_FIXTURE || '').toLowerCase() === 'true') {
    return { kind: 'fixture', model: 'fixture' };
  }
  if (typeof env.AI_API_KEY === 'string' && env.AI_API_KEY.trim()) {
    return { kind: 'external', model: env.AI_MODEL || DEFAULT_EXTERNAL_MODEL };
  }
  if (env.AI && typeof env.AI.run === 'function') {
    return { kind: 'workers-ai', model: env.WORKERS_AI_MODEL || DEFAULT_WORKERS_MODEL };
  }
  return { kind: 'none', model: null };
}

export function validateApiUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'https:') return 'https_required';
  if (url.username || url.password) return 'credentials_not_allowed';
  const host = url.hostname.toLowerCase();
  if (!host) return 'missing_host';
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    return 'private_host';
  }
  if (host.startsWith('[') || host.includes(':')) return 'ip_literal';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) return 'ip_literal';
  return null;
}

function contentFromOpenAi(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  }
  return '';
}

function usageFrom(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    prompt_tokens: Number(usage.prompt_tokens) || 0,
    completion_tokens: Number(usage.completion_tokens) || 0,
    total_tokens: Number(usage.total_tokens) || 0
  };
}

export async function callAI(env, input, options = {}) {
  const provider = pickProvider(env);
  if (provider.kind === 'none') throw new AiError('ai_not_configured', 503);
  if (provider.kind === 'fixture') {
    return {
      text: JSON.stringify(fixtureReport(input)),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, fixture: true },
      provider: 'fixture',
      model: 'fixture'
    };
  }
  if (provider.kind === 'external') return callExternal(env, input, options);
  return callWorkersAi(env, input, options);
}

async function callExternal(env, input, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const apiUrl = env.AI_API_URL || DEFAULT_API_URL;
  const urlProblem = validateApiUrl(apiUrl);
  if (urlProblem) throw new AiError('ai_config_invalid', 503, urlProblem);

  const model = env.AI_MODEL || DEFAULT_EXTERNAL_MODEL;
  const body = {
    model,
    messages: buildMessages(input),
    temperature: 0.2,
    max_tokens: 1600
  };
  if (String(env.AI_JSON_MODE || 'true') !== 'false') {
    body.response_format = { type: 'json_object' };
  }

  const signal = options.signal || AbortSignal.timeout(AI_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_API_KEY}`
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AiError('ai_timeout', 504);
    }
    throw new AiError('ai_upstream_error', 502, String(error?.message || error).slice(0, 500));
  }

  const raw = await response.text();
  if (!response.ok) {
    const mapped = response.status === 401 || response.status === 403
      ? 'ai_auth_failed'
      : response.status === 429
        ? 'ai_rate_limited'
        : 'ai_upstream_error';
    throw new AiError(mapped, 502, `upstream ${response.status}: ${raw.slice(0, 1500)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AiError('ai_invalid_response', 502, raw.slice(0, 1500));
  }
  if (data?.choices?.[0]?.finish_reason === 'length') {
    throw new AiError('ai_truncated', 502, 'finish_reason=length');
  }
  const text = contentFromOpenAi(data);
  if (!text.trim()) throw new AiError('ai_invalid_response', 502, 'empty content');
  return { text, usage: usageFrom(data), provider: 'external', model };
}

async function callWorkersAi(env, input, options) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new AiError('ai_not_configured', 503);
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_MODEL;
  const messages = buildMessages(input);
  const base = { messages, max_tokens: 1600, temperature: 0.2 };
  if (String(env.AI_JSON_MODE || 'true') !== 'false') {
    base.response_format = { type: 'json_object' };
  }
  const first = model.includes('qwen3')
    ? { ...base, chat_template_kwargs: { enable_thinking: false } }
    : base;
  let result;
  try {
    result = await withTimeout(env.AI.run(model, first), AI_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof AiError) throw error;
    try {
      result = await withTimeout(env.AI.run(model, base), AI_TIMEOUT_MS);
    } catch (second) {
      throw new AiError('ai_upstream_error', 502, String(second?.message || second).slice(0, 500));
    }
  }

  const text = typeof result?.response === 'string'
    ? result.response
    : contentFromOpenAi(result);
  if (!text || !text.trim()) {
    const preview = JSON.stringify(result).slice(0, 1200);
    throw new AiError('ai_invalid_response', 502, `empty Workers AI content; raw=${preview}`);
  }
  return { text, usage: usageFrom(result), provider: 'workers-ai', model };
}

function withTimeout(promise, ms) {
  let timer;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AiError('ai_timeout', 504)), ms);
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

const FIXTURE_ESSAY = `Morning reading has changed my life. It is the small habit that has broadened my horizons and calmed my mind.

I used to rush to school with a mind as noisy as a train station. However, my teacher suggested fifteen minutes of reading every morning. Greatly inspired, I decided to give it a go. At first, I could hardly focus. Little by little, I learned to follow the writer's voice. Now I have finished twelve books this term, and my compositions have become more vivid.

It is this small habit that has given me courage and confidence. I will carry it with me to face every difficulty with a smile.`;

function fixtureStyleCheck() {
  const passes = {
    three_paragraphs: true,
    showcase_per_paragraph: true,
    concrete_number: true,
    metaphor: true,
    time_markers: true,
    word_count: true,
    closing: true,
    vocabulary: true
  };
  const notes = {
    three_paragraphs: '开头、主体、结尾各一段。',
    showcase_per_paragraph: '使用了非谓语开头和 It is...that 强调句。',
    concrete_number: '文中出现了 fifteen minutes 和 twelve books。',
    metaphor: '用 as noisy as a train station 把抽象心情具体化。',
    time_markers: 'At first / However / Now 推进清晰。',
    word_count: '演示：词数在目标区间内。',
    closing: '结尾强调句加展望，收束完整。',
    vocabulary: '词汇以初中核心词为主。'
  };
  return STYLE_ITEMS.map(item => ({
    id: item.id,
    label: item.label,
    pass: passes[item.id] ?? null,
    note: notes[item.id] || '本地演示项'
  }));
}

function fixtureReport(input) {
  const title = input.title || '未命名作文';
  if (input.mode === 'generate') {
    return {
      topic_type: '变化',
      summary: '本地演示：按“变化类”三段式生成，突出习惯带来的改变。',
      outline: [
        { paragraph: 1, goal: '点题：说明变化与主题', key_points: ['用 It is...that 强调', '给出中心词 habit'] },
        { paragraph: 2, goal: '叙述过去、转折与具体行动', key_points: ['I used to...', 'However...', '数字细节'] },
        { paragraph: 3, goal: '强调改变并展望', key_points: ['It is...that', 'with a smile'] }
      ],
      essay: FIXTURE_ESSAY,
      highlights: [
        { pattern: 'It is...that 强调句', sentence: 'It is the small habit that has broadened my horizons.' },
        { pattern: '非谓语开头', sentence: 'Greatly inspired, I decided to give it a go.' }
      ],
      style_check: fixtureStyleCheck()
    };
  }
  return {
    topic_type: '变化',
    subscores: { content: 4, language: 4, structure: 4.5 },
    summary: `本地演示报告：这篇《${title}》三段清楚、主题明确，升级版主要收紧长句并让结尾更具体。`,
    strengths: [
      { point: '三段结构清晰', evidence: '开头点题，主体叙述，结尾收束。' },
      { point: '有具体行动和时间推进', evidence: 'At first... However... Now...' }
    ],
    improvements: [
      { issue: '个别长句偏挤', suggestion: '拆成短句，节奏更稳。', example: 'Reading calms my mind. It also broadens my horizons.' },
      { issue: '结尾略空', suggestion: '把“改变”落到一个具体行动上。', example: 'I will keep fifteen minutes for reading every morning.' }
    ],
    sentence_fixes: [
      { original: 'My life has changed a lot because of morning reading.', revised: 'A small habit, morning reading, has quietly changed my life.', reason: '更具体，也更有画面感。' }
    ],
    style_check: fixtureStyleCheck(),
    upgraded_essay: FIXTURE_ESSAY,
    next_steps: ['把第二段的长句拆成短句，节奏更稳。', '结尾补一个可执行的下一步。', '提交前数一遍词数。']
  };
}
