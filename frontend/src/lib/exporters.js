import { formatDate } from './format.js';
import { getTaskStatusLabel } from './statusLabels.js';

// Labels for the meeting-type picker only - the actual section structure per
// type (which drives generation/rendering) lives server-side
// (backend/src/protocolTemplates.js) and comes back on `recording.protocolTemplate`.
export const MEETING_TYPE_OPTIONS = [
  { value: 'meeting', label: 'Совещание' },
  { value: 'planning', label: 'Планёрка' },
  { value: 'negotiation', label: 'Переговоры' },
  { value: 'interview', label: 'Интервью' },
  { value: 'project', label: 'Проектная встреча' },
  { value: 'freeform', label: 'Свои мысли' },
];

export const PROTOCOL_SECTION_LABELS = {
  participants: 'Участники',
  agenda: 'Повестка',
  discussions: 'Обсуждения',
  decisions: 'Решения',
  risks: 'Риски',
  questions: 'Открытые вопросы',
  nextSteps: 'Следующие шаги',
};

function escapeTableCell(value) {
  return String(value || '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// С эпика 10 запись может состоять в нескольких проектах (recording.projects);
// одиночный recording.project остаётся как «первый проект» для старых данных.
function projectNames(recording) {
  const projects = recording.projects?.length ? recording.projects : recording.project ? [recording.project] : [];
  return projects.map((project) => project.name).join(', ') || 'без проекта';
}

function formatMarkdownList(items) {
  return items?.length ? items.map((item) => `- ${item}`).join('\n') : '- не выделено';
}

// `decisions` items are {text, disputed} objects - everything else in
// `protocol` is a plain string[]. Disputed decisions get a ⚠ marker since
// the yellow highlight (US-8.1) is a visual-only cue that plain text can't
// reproduce.
function protocolSectionLines(sectionKey, items) {
  if (sectionKey === 'decisions') {
    return (items || []).map((item) => (item?.disputed ? `⚠ ${item.text}` : item?.text)).filter(Boolean);
  }

  return (items || []).map((item) => String(item || '')).filter(Boolean);
}

export function buildRecordingExport(recording) {
  const summary = recording.summary;
  const protocol = summary?.protocol;
  const tasks = recording.tasks || [];
  const speakers = recording.speakers || [];
  const lines = [
    `# ${recording.title}`,
    '',
    `Файл: ${recording.originalFilename || 'не прикреплен'}`,
    `Дата загрузки: ${formatDate(recording.createdAt)}`,
    `Статус: ${recording.status}`,
    `Проекты: ${projectNames(recording)}`,
    '',
  ];

  if (summary?.executiveSummary) {
    lines.push('## Executive summary', '', summary.executiveSummary, '');
  }

  lines.push('## Резюме', '', summary?.summary || 'Резюме пока нет.', '');

  lines.push('## Протокол', '');
  if (protocol) {
    const template = recording.protocolTemplate || { sections: ['agenda', 'decisions', 'risks'] };
    template.sections.forEach((key) => {
      lines.push(`### ${PROTOCOL_SECTION_LABELS[key] || key}`, formatMarkdownList(protocolSectionLines(key, protocol[key])), '');
    });
  } else {
    lines.push('Протокол пока не создан.', '');
  }

  lines.push('## Задачи', '');
  if (tasks.length) {
    lines.push('| Исполнитель | Срок | Статус | Описание |');
    lines.push('| --- | --- | --- | --- |');
    tasks.forEach((task) => {
      lines.push(
        `| ${escapeTableCell(task.assignee)} | ${escapeTableCell(task.dueText)} | ${escapeTableCell(task.status)} | ${escapeTableCell(task.description)} |`,
      );
    });
    lines.push('');
  } else {
    lines.push('Задач пока нет.', '');
  }

  lines.push('## Спикеры', '');
  if (speakers.length) {
    speakers.forEach((speaker) => {
      const displayName = speaker.displayName || speaker.label;
      const contact = [speaker.contactName, speaker.contactEmail].filter(Boolean).join(', ');
      lines.push(`- ${displayName}${contact ? ` (${contact})` : ''}`);
    });
    lines.push('');
  } else {
    lines.push('Спикеры пока не выделены.', '');
  }

  lines.push('## Стенограмма', '', recording.transcript?.text || 'Стенограммы пока нет.', '');

  return lines.join('\n');
}

export function exportBaseName(recording) {
  return (recording.title || recording.originalFilename || 'recording')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'recording';
}

export function createExportFilename(recording) {
  return `${exportBaseName(recording)}-protocol.md`;
}

// Dynamically imported - same reasoning as TranscriptView.jsx's DOCX export:
// docx roughly doubles the bundle and is a rarely-used path.
export async function buildProtocolDocxBlob(recording) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const summary = recording.summary;
  const protocol = summary?.protocol;
  const template = recording.protocolTemplate || { sections: ['agenda', 'decisions', 'risks'] };
  const children = [
    new Paragraph({ text: recording.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `${formatDate(recording.createdAt)} · ${projectNames(recording)}` }),
  ];

  if (summary?.executiveSummary) {
    children.push(new Paragraph({ text: 'Executive summary', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: summary.executiveSummary }));
  }

  children.push(new Paragraph({ text: 'Резюме', heading: HeadingLevel.HEADING_2 }));
  children.push(new Paragraph({ text: summary?.summary || 'Резюме пока нет.' }));

  children.push(new Paragraph({ text: 'Протокол', heading: HeadingLevel.HEADING_2 }));
  if (protocol) {
    template.sections.forEach((key) => {
      children.push(new Paragraph({ text: PROTOCOL_SECTION_LABELS[key] || key, heading: HeadingLevel.HEADING_3 }));
      const lines = protocolSectionLines(key, protocol[key]);

      if (lines.length) {
        lines.forEach((line) => children.push(new Paragraph({ text: line, bullet: { level: 0 } })));
      } else {
        children.push(new Paragraph({ text: 'Не выделено.' }));
      }
    });
  } else {
    children.push(new Paragraph({ text: 'Протокол пока не создан.' }));
  }

  children.push(new Paragraph({ text: 'Задачи', heading: HeadingLevel.HEADING_2 }));
  const tasks = recording.tasks || [];
  if (tasks.length) {
    tasks.forEach((task) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${task.assignee || 'не указан'} · ${task.dueText || 'не указан'} · ${task.status}: `, bold: true }),
            new TextRun({ text: task.description }),
          ],
        }),
      );
    });
  } else {
    children.push(new Paragraph({ text: 'Задач пока нет.' }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// US-10.2: экспорт результатов поиска задач в Markdown-таблицу.
export function buildTaskSearchExport(tasks, filters = {}) {
  const activeFilters = Object.entries(filters)
    .filter(([, value]) => value && String(value).trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  const lines = [
    '# Поиск задач',
    '',
    `Дата экспорта: ${formatDate(new Date().toISOString())}`,
    activeFilters ? `Фильтры: ${activeFilters}` : 'Фильтры: не заданы',
    `Найдено задач: ${tasks.length}`,
    '',
  ];

  if (tasks.length) {
    lines.push('| Исполнитель | Срок | Статус | Задача | Встреча |');
    lines.push('| --- | --- | --- | --- | --- |');
    tasks.forEach((task) => {
      lines.push(
        `| ${escapeTableCell(task.assignee)} | ${escapeTableCell(task.dueDate ? formatDate(task.dueDate) : task.dueText)} | ${escapeTableCell(getTaskStatusLabel(task.status))} | ${escapeTableCell(task.description)} | ${escapeTableCell(task.recordingTitle)} |`,
      );
    });
    lines.push('');
  } else {
    lines.push('Ничего не найдено.', '');
  }

  return lines.join('\n');
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(filename, blob);
}
