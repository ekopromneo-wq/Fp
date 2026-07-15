import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { PROTOCOL_SECTION_LABELS, getProtocolTemplate } from './protocolTemplates.js';

// Те же правила, что во фронтовом exporters.js: решения эпика 8 — объекты
// {text, disputed}, остальные секции — строки.
function protocolSectionLines(sectionKey, items) {
  if (sectionKey === 'decisions') {
    return (items || []).map((item) => (item?.disputed ? `⚠ ${item.text}` : item?.text)).filter(Boolean);
  }

  return (items || []).map((item) => String(item || '')).filter(Boolean);
}

function projectNames(recording) {
  const projects = recording.projects?.length ? recording.projects : recording.project ? [recording.project] : [];
  return projects.map((project) => project.name).join(', ') || 'без проекта';
}

function safeFileName(recording) {
  const base =
    String(recording.title || recording.originalFilename || 'recording')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'recording';

  return `${base}.docx`;
}

/**
 * Вложение к письму (US-11.2). Повторяет структуру фронтового экспорта
 * (`buildProtocolDocxBlob`) — получатель письма и владелец встречи должны
 * видеть один и тот же документ; payloadKind режет разделы так же, как в теле
 * письма.
 */
export async function buildProtocolDocxBuffer(recording, payloadKind = 'protocol') {
  const summary = recording.summary;
  const protocol = summary?.protocol;
  const template = getProtocolTemplate(recording.meetingType);
  const withSummary = payloadKind === 'protocol' || payloadKind === 'summary';
  const withProtocol = payloadKind === 'protocol';
  const withTasks = payloadKind === 'protocol' || payloadKind === 'tasks';

  const children = [
    new Paragraph({ text: recording.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: projectNames(recording) }),
  ];

  if (withSummary && summary?.executiveSummary) {
    children.push(new Paragraph({ text: 'Executive summary', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: summary.executiveSummary }));
  }

  if (withSummary) {
    children.push(new Paragraph({ text: 'Резюме', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: summary?.summary || 'Резюме пока нет.' }));
  }

  if (withProtocol) {
    children.push(new Paragraph({ text: 'Протокол', heading: HeadingLevel.HEADING_2 }));

    if (protocol) {
      for (const key of template.sections) {
        children.push(new Paragraph({ text: PROTOCOL_SECTION_LABELS[key] || key, heading: HeadingLevel.HEADING_3 }));
        const lines = protocolSectionLines(key, protocol[key]);

        if (lines.length) {
          lines.forEach((line) => children.push(new Paragraph({ text: line, bullet: { level: 0 } })));
        } else {
          children.push(new Paragraph({ text: 'Не выделено.' }));
        }
      }
    } else {
      children.push(new Paragraph({ text: 'Протокол пока не создан.' }));
    }
  }

  if (withTasks) {
    children.push(new Paragraph({ text: 'Задачи', heading: HeadingLevel.HEADING_2 }));
    const tasks = recording.tasks || [];

    if (tasks.length) {
      for (const task of tasks) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${task.assignee || 'не указан'} · ${task.dueText || 'не указан'} · ${task.status}: `,
                bold: true,
              }),
              new TextRun({ text: task.description }),
            ],
          }),
        );
      }
    } else {
      children.push(new Paragraph({ text: 'Задач пока нет.' }));
    }
  }

  const doc = new Document({ sections: [{ children }] });

  return { filename: safeFileName(recording), buffer: await Packer.toBuffer(doc) };
}
