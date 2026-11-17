import { cleanText, HttpError, isPlainObject, isUuid, textField } from './http.js';

export const STYLE_ITEMS = [
  { id: 'three_paragraphs', label: '三段式结构' },
  { id: 'showcase_per_paragraph', label: '标志句型' },
  { id: 'concrete_number', label: '具体数字/细节' },
  { id: 'metaphor', label: '具体比喻' },
  { id: 'time_markers', label: '时间推进词' },
  { id: 'word_count', label: '词数 100–140' },
  { id: 'closing', label: '结尾强调与展望' },
  { id: 'vocabulary', label: '词汇控制' }
];

const TOPIC_TYPES = new Set(['人物', '变化', '记忆', '书信', '其他']);

export class OutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputError';
  }
}

export function countWords(text) {
  const value = String(text || '');
  const words = value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [];
  return words.length + cjk.length;
}

export function normalizeInput(body) {
  if (!isPlainObject(body)) throw new HttpError('invalid_input', 400);
  if (body.mode !== 'grade' && body.mode !== 'generate') {
    throw new HttpError('invalid_mode', 400);
  }
  if (!isUuid(body.requestId)) throw new HttpError('invalid_request_id', 400);

  const title = textField(body.title, 300, 'title_too_long');
  const requirements = textField(body.requirements, 500, 'requirements_too_long');
  let essay = textField(body.essay, 4000, 'essay_too_long');

  if (body.mode === 'generate') {
    if (title.length < 3) throw new HttpError('title_required', 400);
    essay = '';
  } else {
    if (essay.length < 40) throw new HttpError('essay_too_short', 400);
    const words = countWords(essay);
    if (words < 20) throw new HttpError('essay_too_short', 400);
    if (words > 400) throw new HttpError('essay_too_long', 413);
  }

  return {
    requestId: body.requestId,
    mode: body.mode,
    title,
    essay,
    requirements,
    wordCount: countWords(essay)
  };
}

export async function fingerprint(input) {
  const canonical = JSON.stringify({
    mode: input.mode,
    title: input.title,
    essay: input.essay,
    requirements: input.requirements
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function bandFor(total) {
  if (total >= 13) return '优秀';
  if (total >= 10) return '良好';
  if (total >= 7) return '及格';
  return '待提升';
}

function halfPoint(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new OutputError(`missing score: ${field}`);
  return Math.round(Math.max(0, Math.min(5, number)) * 2) / 2;
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function objectList(value, maxItems, mapper) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map(mapper)
    .filter(Boolean);
}

function normalizeStyleCheck(value) {
  const parsed = new Map();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const id = String(item.id || '');
      if (!STYLE_ITEMS.some(entry => entry.id === id)) continue;
      const pass = item.pass === true || item.pass === 'true'
        ? true
        : item.pass === false || item.pass === 'false'
          ? false
          : null;
      parsed.set(id, {
        pass,
        note: cleanText(item.note, 200) || 'AI 未返回说明'
      });
    }
  }
  return STYLE_ITEMS.map(entry => ({
    id: entry.id,
    label: entry.label,
    pass: parsed.get(entry.id)?.pass ?? null,
    note: parsed.get(entry.id)?.note ?? 'AI 未返回该项'
  }));
}

function normalizeTopic(value) {
  const topic = String(value || '').trim();
  return TOPIC_TYPES.has(topic) ? topic : '其他';
}

export function extractJson(value) {
  if (isPlainObject(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) throw new OutputError('empty AI response');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new OutputError('no JSON object found');
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new OutputError('invalid JSON from AI');
  }
}

export function normalizeReport(parsed, input) {
  const topicType = normalizeTopic(parsed.topic_type);
  const styleCheck = normalizeStyleCheck(parsed.style_check);

  if (input.mode === 'generate') {
    const essay = cleanText(parsed.essay, 5000);
    if (essay.length < 20) throw new OutputError('missing generated essay');
    const outline = objectList(parsed.outline, 6, (item, index) => {
      if (!isPlainObject(item)) return null;
      const goal = cleanText(item.goal, 200);
      if (!goal) return null;
      return {
        paragraph: Number.isInteger(item.paragraph) ? item.paragraph : index + 1,
        goal,
        key_points: stringList(item.key_points, 5, 120)
      };
    });
    const highlights = objectList(parsed.highlights, 5, item => {
      if (!isPlainObject(item)) return null;
      const sentence = cleanText(item.sentence, 300);
      if (!sentence) return null;
      return { pattern: cleanText(item.pattern, 80), sentence };
    });
    return {
      mode: 'generate',
      topic_type: topicType,
      outline,
      essay,
      essay_word_count: countWords(essay),
      highlights,
      style_check: styleCheck,
      summary: cleanText(parsed.summary, 400) || '范文已生成，请对照风格清单自查。'
    };
  }

  if (!isPlainObject(parsed.subscores)) throw new OutputError('missing subscores');
  const content = halfPoint(parsed.subscores.content, 'content');
  const language = halfPoint(parsed.subscores.language, 'language');
  const structure = halfPoint(parsed.subscores.structure, 'structure');
  const total = Math.round((content + language + structure) * 2) / 2;
  const upgraded = cleanText(parsed.upgraded_essay, 5000);

  return {
    mode: 'grade',
    topic_type: topicType,
    subscores: { content, language, structure },
    overall_score: total,
    band: bandFor(total),
    word_count: countWords(input.essay),
    summary: cleanText(parsed.summary, 600) || 'AI 未返回总评。',
    strengths: objectList(parsed.strengths, 5, item => {
      if (!isPlainObject(item)) return null;
      const point = cleanText(item.point, 160);
      if (!point) return null;
      return { point, evidence: cleanText(item.evidence, 300) };
    }),
    improvements: objectList(parsed.improvements, 5, item => {
      if (!isPlainObject(item)) return null;
      const issue = cleanText(item.issue, 160);
      if (!issue) return null;
      return {
        issue,
        suggestion: cleanText(item.suggestion, 300),
        example: cleanText(item.example, 300)
      };
    }),
    sentence_fixes: objectList(parsed.sentence_fixes, 4, item => {
      if (!isPlainObject(item)) return null;
      const original = cleanText(item.original, 300);
      const revised = cleanText(item.revised, 300);
      if (!original || !revised) return null;
      return { original, revised, reason: cleanText(item.reason, 200) };
    }),
    style_check: styleCheck,
    upgraded_essay: upgraded || null,
    upgraded_word_count: upgraded ? countWords(upgraded) : 0,
    next_steps: stringList(parsed.next_steps, 4, 160)
  };
}
