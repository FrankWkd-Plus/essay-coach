function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function formatScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function passIcon(pass) {
  if (pass === true) return { text: '✓', className: 'is-pass' };
  if (pass === false) return { text: '✗', className: 'is-fail' };
  return { text: '–', className: 'is-na' };
}

function reportHeader(report, meta) {
  const top = el('div', 'report-top');
  const heading = el('div', 'report-heading');
  heading.append(el('p', 'eyebrow', report.mode === 'generate' ? 'MODEL ESSAY' : 'GRADE REPORT'));
  heading.append(el('h3', 'report-title', meta.title || '未命名作文'));
  const bits = [
    report.mode === 'generate' ? '范文生成' : '作文批改',
    `${report.mode === 'generate' ? report.essay_word_count : report.word_count} 词`,
    report.topic_type ? `${report.topic_type}类` : '',
    formatDate(meta.submittedAt)
  ].filter(Boolean);
  heading.append(el('p', 'report-sub', bits.join(' · ')));
  top.append(heading);

  if (report.mode === 'generate') {
    top.append(el('span', 'topic-chip', report.topic_type ? `${report.topic_type}类` : '范文'));
  } else {
    const stamp = el('div', 'score-stamp');
    stamp.append(el('span', 'score-number', formatScore(report.overall_score)));
    stamp.append(el('span', 'score-denom', '/ 15'));
    stamp.append(el('span', 'score-label', report.band || '得分'));
    top.append(stamp);
  }
  return top;
}

function subscoreGrid(report) {
  const grid = el('div', 'subscore-grid');
  const items = [
    ['内容', report.subscores?.content],
    ['语言', report.subscores?.language],
    ['结构', report.subscores?.structure]
  ];
  for (const [label, value] of items) {
    const card = el('div', 'subscore');
    card.append(el('span', '', label));
    card.append(el('strong', '', formatScore(value)));
    card.append(el('em', '', '/ 5'));
    grid.append(card);
  }
  return grid;
}

function pointList(items, kind) {
  const list = el('ul', 'point-list');
  if (!Array.isArray(items) || items.length === 0) {
    list.append(el('li', 'point-title', '暂无'));
    return list;
  }
  for (const item of items) {
    const li = el('li');
    if (kind === 'strength') {
      li.append(el('span', 'point-title', item.point || ''));
      if (item.evidence) li.append(el('span', 'point-evidence', item.evidence));
    } else {
      li.append(el('span', 'point-title', item.issue || ''));
      const detail = [item.suggestion, item.example ? `例：${item.example}` : '']
        .filter(Boolean).join(' ');
      if (detail) li.append(el('span', 'point-evidence', detail));
    }
    list.append(li);
  }
  return list;
}

function section(title, note, ...children) {
  const wrapper = el('div', 'report-section');
  const heading = el('div', 'section-heading');
  heading.append(el('h4', '', title));
  if (note) heading.append(el('span', 'section-note', note));
  wrapper.append(heading);
  for (const child of children) {
    if (child) wrapper.append(child);
  }
  return wrapper;
}

function fixList(fixes) {
  const list = el('div', 'fix-list');
  if (!Array.isArray(fixes) || fixes.length === 0) {
    list.append(el('p', 'fine-print', '这篇作文没有列出逐句修改。'));
    return list;
  }
  for (const fix of fixes) {
    const card = el('div', 'fix-card');
    const original = el('div', 'fix-line fix-original');
    original.append(el('span', 'fix-label', '原句'));
    original.append(el('p', '', fix.original));
    const revised = el('div', 'fix-line fix-revised');
    revised.append(el('span', 'fix-label', '改句'));
    revised.append(el('p', '', fix.revised));
    card.append(original, revised);
    if (fix.reason) card.append(el('p', 'fix-reason', fix.reason));
    list.append(card);
  }
  return list;
}

function checklist(items) {
  const list = el('div', 'checklist');
  for (const item of Array.isArray(items) ? items : []) {
    const row = el('div', 'check-row');
    const icon = passIcon(item.pass);
    row.append(el('span', `check-icon ${icon.className}`, icon.text));
    row.append(el('span', 'check-label', item.label || item.id || '检查项'));
    row.append(el('span', 'check-note', item.note || ''));
    list.append(row);
  }
  return list;
}

function essayPanel(text) {
  const panel = el('div', 'essay-panel');
  panel.append(el('p', 'essay-text', text || ''));
  return panel;
}

function outlineGrid(outline) {
  const grid = el('div', 'outline-grid');
  for (const item of Array.isArray(outline) ? outline : []) {
    const card = el('div', 'outline-card');
    card.append(el('strong', '', `第 ${item.paragraph || '?'} 段`));
    card.append(el('p', '', item.goal || ''));
    if (Array.isArray(item.key_points) && item.key_points.length) {
      const ul = el('ul');
      for (const point of item.key_points) ul.append(el('li', '', point));
      card.append(ul);
    }
    grid.append(card);
  }
  return grid;
}

function highlightList(items) {
  const list = el('ul', 'highlight-list');
  for (const item of Array.isArray(items) ? items : []) {
    const li = el('li');
    li.append(el('span', 'highlight-pattern', item.pattern || '亮点句型'));
    li.append(document.createTextNode(item.sentence || ''));
    list.append(li);
  }
  return list;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path; some embedded browsers deny the async API.
    }
  }
  const area = el('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    area.remove();
  }
  return ok;
}

function markdownFor(report, meta) {
  const lines = [`# ${meta.title || '未命名作文'}`, ''];
  lines.push(`- 模式：${report.mode === 'generate' ? '范文生成' : '作文批改'}`);
  if (report.mode === 'grade') {
    lines.push(`- 得分：${formatScore(report.overall_score)} / 15（${report.band}）`);
    lines.push(`- 子项：内容 ${formatScore(report.subscores?.content)} / 5；语言 ${formatScore(report.subscores?.language)} / 5；结构 ${formatScore(report.subscores?.structure)} / 5`);
    lines.push(`- 词数：${report.word_count}`);
  } else {
    lines.push(`- 词数：${report.essay_word_count}`);
  }
  if (report.topic_type) lines.push(`- 类型：${report.topic_type}`);
  if (meta.submittedAt) lines.push(`- 时间：${formatDate(meta.submittedAt)}`);
  lines.push('');

  if (report.summary) lines.push('## 总评', '', report.summary, '');

  if (report.mode === 'grade') {
    lines.push('## 亮点', '');
    for (const item of report.strengths || []) {
      lines.push(`- **${item.point}**${item.evidence ? `：${item.evidence}` : ''}`);
    }
    lines.push('', '## 待改进', '');
    for (const item of report.improvements || []) {
      const detail = [item.suggestion, item.example ? `例：${item.example}` : ''].filter(Boolean).join(' ');
      lines.push(`- **${item.issue}**${detail ? `：${detail}` : ''}`);
    }
    lines.push('', '## 逐句修改', '');
    for (const fix of report.sentence_fixes || []) {
      lines.push(`- 原句：${fix.original}`);
      lines.push(`  - 改句：${fix.revised}`);
      if (fix.reason) lines.push(`  - 原因：${fix.reason}`);
    }
    lines.push('');
  } else {
    lines.push('## 提纲', '');
    for (const item of report.outline || []) {
      lines.push(`- 第 ${item.paragraph} 段：${item.goal}`);
      for (const point of item.key_points || []) lines.push(`  - ${point}`);
    }
    lines.push('', '## 范文', '', report.essay || '', '');
    lines.push('## 亮点句型', '');
    for (const item of report.highlights || []) lines.push(`- **${item.pattern}**：${item.sentence}`);
    lines.push('');
  }

  lines.push('## 风格清单', '');
  for (const item of report.style_check || []) {
    const mark = item.pass === true ? '✓' : item.pass === false ? '✗' : '–';
    lines.push(`- ${mark} ${item.label}：${item.note}`);
  }
  lines.push('');

  if (report.mode === 'grade' && report.upgraded_essay) {
    lines.push(`## 升级版（${report.upgraded_word_count} 词）`, '', report.upgraded_essay, '');
  }
  if (report.next_steps?.length) {
    lines.push('## 下一步', '');
    report.next_steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }
  lines.push('> AI 评分仅供参考，不能替代老师评语。');
  lines.push(`> 模型：${report.provider || 'unknown'} / ${report.model || 'unknown'} · Prompt：${report.prompt_version || 'unknown'}`);
  return lines.join('\n');
}

function downloadMarkdown(report, meta) {
  const markdown = markdownFor(report, meta);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  const safe = (meta.title || 'essay').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'essay';
  link.download = `${safe}-report.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderReport(container, report, meta, { onToast } = {}) {
  clear(container);
  container.append(reportHeader(report, meta));

  if (report.mode === 'grade') {
    container.append(subscoreGrid(report));
  }

  if (report.summary) {
    container.append(section('总评', '', el('p', 'summary', report.summary)));
  }

  if (report.mode === 'grade') {
    const insights = el('div', 'insight-grid');
    const strengths = el('div', 'insight-card is-strength');
    strengths.append(el('h4', '', '亮点'));
    strengths.append(pointList(report.strengths, 'strength'));
    const improvements = el('div', 'insight-card is-improve');
    improvements.append(el('h4', '', '待改进'));
    improvements.append(pointList(report.improvements, 'improve'));
    insights.append(strengths, improvements);
    container.append(insights);

    container.append(section('逐句修改', `${report.sentence_fixes?.length || 0} 处`, fixList(report.sentence_fixes)));
  } else {
    if (Array.isArray(report.outline) && report.outline.length) {
      container.append(section('提纲', '跟着三段走', outlineGrid(report.outline)));
    }
    container.append(section('范文', `${report.essay_word_count} 词`, essayPanel(report.essay)));
    if (Array.isArray(report.highlights) && report.highlights.length) {
      container.append(section('亮点句型', '可迁移', highlightList(report.highlights)));
    }
  }

  container.append(section(
    '风格清单',
    '✓ 通过 · ✗ 待改 · – 未判断',
    checklist(report.style_check)
  ));

  if (report.mode === 'grade') {
    container.append(section(
      '升级版',
      report.upgraded_essay ? `${report.upgraded_word_count} 词` : '',
      report.upgraded_essay
        ? essayPanel(report.upgraded_essay)
        : el('p', 'fine-print', 'AI 未返回升级版全文。')
    ));
  }

  if (Array.isArray(report.next_steps) && report.next_steps.length) {
    const list = el('ol', 'next-list');
    for (const step of report.next_steps) list.append(el('li', '', step));
    container.append(section('下一步', '', list));
  }

  const actions = el('div', 'report-actions');
  const copy = el('button', 'secondary-button', '复制报告');
  copy.type = 'button';
  copy.dataset.action = 'copy';
  const download = el('button', 'secondary-button', '下载 .md');
  download.type = 'button';
  download.dataset.action = 'download';
  const print = el('button', 'secondary-button', '打印');
  print.type = 'button';
  print.dataset.action = 'print';
  actions.append(copy, download, print);
  container.append(actions);

  actions.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === 'copy') {
        const ok = await copyText(markdownFor(report, meta));
        onToast?.(ok
          ? '报告已复制到剪贴板。'
          : '浏览器拦截了复制，请使用“下载 .md”。');
      } else if (action === 'download') {
        downloadMarkdown(report, meta);
        onToast?.('Markdown 已开始下载。');
      } else if (action === 'print') {
        window.print();
      }
    } catch {
      onToast?.('操作失败，请重试。');
    }
  });

  container.append(el(
    'p',
    'report-footnote',
    `模型 ${report.provider || 'unknown'} / ${report.model || 'unknown'} · Prompt ${report.prompt_version || 'unknown'} · AI 评分仅供参考`
  ));
}
