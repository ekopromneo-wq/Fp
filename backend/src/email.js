import nodemailer from 'nodemailer';
import { PROTOCOL_SECTION_LABELS, getProtocolTemplate } from './protocolTemplates.js';

function getSmtpConfig(input = {}) {
  const host = input.host || process.env.SMTP_HOST;
  const port = Number(input.port || process.env.SMTP_PORT || 587);
  const user = input.user || process.env.SMTP_USER;
  const pass = input.pass || process.env.SMTP_PASS;
  const from = input.from || process.env.SMTP_FROM || user;

  if (!host || !from) {
    throw new Error('SMTP is not configured');
  }

  return {
    host,
    port,
    secure:
      input.secure === true || String(input.secure ?? process.env.SMTP_SECURE ?? '').toLowerCase() === 'true' || port === 465,
    auth: user && pass ? { user, pass } : undefined,
    from,
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeRecipients(input) {
  const source = Array.isArray(input) ? input : String(input || '').split(/[,\n;]/);
  const recipients = source.map((item) => String(item || '').trim()).filter(Boolean);
  const unique = [...new Set(recipients.map((item) => item.toLowerCase()))];

  if (unique.length === 0) {
    throw new Error('At least one recipient is required');
  }

  if (unique.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Recipient email is invalid');
  }

  return unique;
}

// `decisions` items are {text, disputed} objects (US-8.1), everything else
// in `protocol` is a plain string[] - normalize to display strings here so
// the two list-formatters below don't need to know about the distinction.
function protocolSectionLines(sectionKey, items) {
  if (sectionKey === 'decisions') {
    return (items || []).map((item) => (item?.disputed ? `⚠ ${item.text}` : item?.text)).filter(Boolean);
  }

  return (items || []).map((item) => String(item || '')).filter(Boolean);
}

function formatList(items) {
  return items?.length ? items.map((item) => `- ${item}`).join('\n') : '- не выделено';
}

function formatHtmlList(items) {
  return items?.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>Не выделено.</p>';
}

function buildTasksText(tasks) {
  if (!tasks?.length) {
    return 'Задач пока нет.';
  }

  return tasks
    .map((task) => {
      const assignee = task.assignee || 'не указан';
      const dueText = task.dueText || 'не указан';
      return `- ${assignee} | ${dueText} | ${task.status}: ${task.description}`;
    })
    .join('\n');
}

function buildTasksHtml(tasks) {
  if (!tasks?.length) {
    return '<p>Задач пока нет.</p>';
  }

  const rows = tasks
    .map(
      (task) => `<tr>
        <td>${escapeHtml(task.assignee || 'не указан')}</td>
        <td>${escapeHtml(task.dueText || 'не указан')}</td>
        <td>${escapeHtml(task.status)}</td>
        <td>${escapeHtml(task.description)}</td>
      </tr>`,
    )
    .join('');

  return `<table>
    <thead>
      <tr><th>Исполнитель</th><th>Срок</th><th>Статус</th><th>Описание</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildEmailContent(recording, message = '') {
  const summary = recording.summary;
  const protocol = summary?.protocol || {};
  const template = getProtocolTemplate(recording.meetingType);
  const intro = String(message || '').trim();

  const protocolTextBlocks = template.sections.flatMap((key) => [
    `### ${PROTOCOL_SECTION_LABELS[key]}`,
    formatList(protocolSectionLines(key, protocol[key])),
    '',
  ]);

  const text = [
    intro,
    `# ${recording.title}`,
    '',
    `Файл: ${recording.originalFilename || 'не прикреплен'}`,
    `Проект: ${recording.project?.name || 'без проекта'}`,
    `Статус: ${recording.status}`,
    '',
    ...(summary?.executiveSummary ? ['## Executive summary', summary.executiveSummary, ''] : []),
    '## Резюме',
    summary?.summary || 'Резюме пока нет.',
    '',
    '## Протокол',
    ...protocolTextBlocks,
    '## Задачи',
    buildTasksText(recording.tasks),
  ]
    .filter((item, index) => index !== 0 || item)
    .join('\n');

  const protocolHtmlBlocks = template.sections
    .map(
      (key) => `<h3>${escapeHtml(PROTOCOL_SECTION_LABELS[key])}</h3>${formatHtmlList(protocolSectionLines(key, protocol[key]))}`,
    )
    .join('');

  const html = `<!doctype html>
    <html>
      <body style="font-family: Arial, sans-serif; color: #18221d; line-height: 1.45;">
        ${intro ? `<p>${escapeHtml(intro).replace(/\n/g, '<br>')}</p>` : ''}
        <h1>${escapeHtml(recording.title)}</h1>
        <p>
          <strong>Файл:</strong> ${escapeHtml(recording.originalFilename || 'не прикреплен')}<br>
          <strong>Проект:</strong> ${escapeHtml(recording.project?.name || 'без проекта')}<br>
          <strong>Статус:</strong> ${escapeHtml(recording.status)}
        </p>
        ${summary?.executiveSummary ? `<h2>Executive summary</h2><p>${escapeHtml(summary.executiveSummary).replace(/\n/g, '<br>')}</p>` : ''}
        <h2>Резюме</h2>
        <p>${escapeHtml(summary?.summary || 'Резюме пока нет.')}</p>
        <h2>Протокол</h2>
        ${protocolHtmlBlocks}
        <h2>Задачи</h2>
        ${buildTasksHtml(recording.tasks)}
      </body>
    </html>`;

  return { text, html };
}

export { buildEmailContent };

// Sends a single task (US-9.4 "внешний исполнитель ... задача уходит по
// Email"), not the whole recording protocol - deliberately separate from
// buildEmailContent/sendRecordingEmail, which always dump the entire
// summary/protocol/task table.
export async function sendTaskEmail(smtpConfig, toInput, recording, task) {
  const config = getSmtpConfig(smtpConfig || {});
  const to = normalizeRecipients(toInput);
  const subject = `Задача из встречи "${recording.title}": ${task.description.slice(0, 80)}`;
  const text = [
    `Встреча: ${recording.title}`,
    `Срок: ${task.dueText || 'не указан'}`,
    '',
    task.description,
  ].join('\n');
  const html = `<!doctype html>
    <html>
      <body style="font-family: Arial, sans-serif; color: #18221d; line-height: 1.45;">
        <p><strong>Встреча:</strong> ${escapeHtml(recording.title)}</p>
        <p><strong>Срок:</strong> ${escapeHtml(task.dueText || 'не указан')}</p>
        <p>${escapeHtml(task.description)}</p>
      </body>
    </html>`;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  const result = await transporter.sendMail({ from: config.from, to, subject, text, html });

  return {
    messageId: result.messageId,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
  };
}

// Short "your recording is ready/failed" notification, distinct from
// sendRecordingEmail's full protocol/summary dump (US-5.2 wants a one-line
// status message, not the whole meeting content).
export async function sendNotificationEmail(smtpConfig, to, subject, text) {
  const config = getSmtpConfig(smtpConfig || {});
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  const result = await transporter.sendMail({ from: config.from, to, subject, text });

  return {
    messageId: result.messageId,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
  };
}

export async function sendRecordingEmail(recording, input = {}, smtpConfig = {}) {
  const config = getSmtpConfig(smtpConfig || {});
  const to = normalizeRecipients(input.recipients);
  const subject = String(input.subject || '').trim() || `VoxMate: ${recording.title}`;
  const { text, html } = buildEmailContent(recording, input.message);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  const result = await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });

  return {
    messageId: result.messageId,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
  };
}
