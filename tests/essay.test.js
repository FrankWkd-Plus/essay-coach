import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bandFor, countWords, extractJson, fingerprint, normalizeInput, normalizeReport,
  OutputError, STYLE_ITEMS
} from '../src/essay.js';

const ESSAY = 'My life has changed a lot because of reading. I read fifteen minutes every morning and have finished twelve books this term. It has broadened my horizons and calmed my mind.';

function gradeInput(overrides = {}) {
  return {
    requestId: '123e4567-e89b-12d3-a456-426614174000',
    mode: 'grade',
    title: 'A Change in My Life',
    essay: ESSAY,
    requirements: '',
    wordCount: countWords(ESSAY),
    ...overrides
  };
}

function styleCheck() {
  return STYLE_ITEMS.map(item => ({ id: item.id, label: item.label, pass: true, note: 'ok' }));
}

test('countWords counts contractions and CJK characters', () => {
  assert.equal(countWords("I don't like it."), 4);
  assert.equal(countWords('Hello world'), 2);
  assert.equal(countWords('你好 hello'), 3);
  assert.equal(countWords(''), 0);
});

test('normalizeInput validates grade and generate modes', () => {
  const grade = normalizeInput({
    requestId: '123e4567-e89b-12d3-a456-426614174000',
    mode: 'grade',
    title: '  My Title  ',
    essay: `  ${ESSAY}  `,
    requirements: '  focus on the ending  '
  });
  assert.equal(grade.mode, 'grade');
  assert.equal(grade.title, 'My Title');
  assert.equal(grade.requirements, 'focus on the ending');
  assert.ok(grade.wordCount >= 20);

  assert.throws(() => normalizeInput({ mode: 'grade' }), (error) => error.code === 'invalid_request_id');
  assert.throws(() => normalizeInput({ requestId: '123e4567-e89b-12d3-a456-426614174000', mode: 'bad' }), (error) => error.code === 'invalid_mode');
  assert.throws(() => normalizeInput({
    requestId: '123e4567-e89b-12d3-a456-426614174000',
    mode: 'grade',
    essay: 'Too short.'
  }), (error) => error.code === 'essay_too_short');
  assert.throws(() => normalizeInput({
    requestId: '123e4567-e89b-12d3-a456-426614174000',
    mode: 'generate',
    title: 'Hi'
  }), (error) => error.code === 'title_required');

  const generate = normalizeInput({
    requestId: '123e4567-e89b-12d3-a456-426614174001',
    mode: 'generate',
    title: 'A Memorable School Activity',
    essay: 'ignored because generate mode'
  });
  assert.equal(generate.essay, '');
  assert.equal(generate.mode, 'generate');
});

test('fingerprint is stable and content-sensitive', async () => {
  const first = await fingerprint(gradeInput());
  const second = await fingerprint(gradeInput());
  const changed = await fingerprint(gradeInput({ essay: `${ESSAY} Extra.` }));
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('bandFor maps totals to the 15-point bands', () => {
  assert.equal(bandFor(15), '优秀');
  assert.equal(bandFor(13), '优秀');
  assert.equal(bandFor(12.5), '良好');
  assert.equal(bandFor(10), '良好');
  assert.equal(bandFor(9.5), '及格');
  assert.equal(bandFor(7), '及格');
  assert.equal(bandFor(6.5), '待提升');
});

test('extractJson handles fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} done'), { a: 1 });
  assert.throws(() => extractJson('no json here'), OutputError);
  assert.throws(() => extractJson('{bad}'), OutputError);
});

test('normalizeReport computes the total server-side and fills the checklist', () => {
  const report = normalizeReport({
    topic_type: '变化',
    subscores: { content: 4, language: 4.5, structure: 5 },
    summary: '结构清楚。',
    strengths: [{ point: '有具体数字', evidence: 'fifteen minutes' }],
    improvements: [{ issue: '比喻偏少', suggestion: '补一个画面', example: 'a flood of confusion' }],
    sentence_fixes: [{ original: 'A.', revised: 'B.', reason: '更具体' }],
    style_check: [{ id: 'three_paragraphs', pass: true, note: 'ok' }],
    upgraded_essay: ESSAY,
    next_steps: ['再数一次词数']
  }, gradeInput());

  assert.equal(report.mode, 'grade');
  assert.equal(report.overall_score, 13.5);
  assert.equal(report.band, '优秀');
  assert.equal(report.word_count, countWords(ESSAY));
  assert.equal(report.upgraded_word_count, countWords(ESSAY));
  assert.equal(report.style_check.length, 8);
  assert.equal(report.style_check[0].pass, true);
  assert.equal(report.style_check[1].pass, null);
  assert.equal(report.style_check[1].note, 'AI 未返回该项');
});

test('normalizeReport clamps scores and drops invalid entries', () => {
  const report = normalizeReport({
    topic_type: 'unknown',
    subscores: { content: 9, language: -2, structure: 3.2 },
    summary: '',
    strengths: 'not-an-array',
    improvements: [null, { issue: '' }],
    sentence_fixes: [{ original: 'A', revised: '' }],
    style_check: [
      { id: 'metaphor', pass: 'true', note: 'ok' },
      { id: 'made_up', pass: true, note: 'drop me' },
      { id: 'metaphor', pass: false, note: 'last wins' }
    ],
    upgraded_essay: ''
  }, gradeInput());

  assert.deepEqual(report.subscores, { content: 5, language: 0, structure: 3 });
  assert.equal(report.overall_score, 8);
  assert.equal(report.band, '及格');
  assert.equal(report.topic_type, '其他');
  assert.equal(report.improvements.length, 0);
  assert.equal(report.sentence_fixes.length, 0);
  assert.equal(report.upgraded_essay, null);
  assert.equal(report.style_check.find(item => item.id === 'metaphor').pass, false);
});

test('normalizeReport rejects missing grade subscores', () => {
  assert.throws(() => normalizeReport({ topic_type: '变化' }, gradeInput()), OutputError);
});

test('normalizeReport supports generate mode', () => {
  const report = normalizeReport({
    topic_type: '记忆',
    summary: '选用记忆类三段式。',
    outline: [{ paragraph: 1, goal: '点题', key_points: ['用强调句'] }],
    essay: ESSAY,
    highlights: [{ pattern: 'It is...that', sentence: 'It is reading that changed me.' }],
    style_check: styleCheck()
  }, {
    requestId: '123e4567-e89b-12d3-a456-426614174001',
    mode: 'generate',
    title: 'A Memorable School Activity',
    essay: '',
    requirements: '',
    wordCount: 0
  });

  assert.equal(report.mode, 'generate');
  assert.equal(report.essay_word_count, countWords(ESSAY));
  assert.equal(report.outline.length, 1);
  assert.equal(report.highlights.length, 1);
  assert.equal(report.style_check.length, 8);
  assert.throws(() => normalizeReport({
    topic_type: '记忆', essay: '', style_check: styleCheck()
  }, {
    requestId: '123e4567-e89b-12d3-a456-426614174001',
    mode: 'generate', title: 'A Memorable School Activity', essay: '', requirements: '', wordCount: 0
  }), OutputError);
});
