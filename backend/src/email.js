import nodemailer from 'nodemailer';
import { PROTOCOL_SECTION_LABELS, getProtocolTemplate } from './protocolTemplates.js';
import { PAYLOAD_KINDS, PermanentSendError } from './sending.js';
import { buildProtocolDocxBuffer } from './protocolDocx.js';

function getSmtpConfig(input = {}) {
  const host = input.host || process.env.SMTP_HOST;
  const port = Number(input.port || process.env.SMTP_PORT || 587);
  const user = input.user || process.env.SMTP_USER;
  const pass = input.pass || process.env.SMTP_PASS;
  const from = input.from || process.env.SMTP_FROM || user;

  if (!host || !from) {
    throw new PermanentSendError('Почта не настроена — укажите SMTP в настройках');
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

// US-11.2: «Недействительный адрес → сообщение + предложение выбрать другой».
// Называем конкретный адрес — иначе из списка в десяток получателей непонятно,
// какой именно переписывать. PermanentSendError, чтобы отправка не уходила на
// три круга повторов из-за опечатки.
function normalizeRecipients(input, { field = 'Получатель' } = {}) {
  const source = Array.isArray(input) ? input : String(input || '').split(/[,\n;]/);
  const recipients = source.map((item) => String(item || '').trim()).filter(Boolean);
  const unique = [...new Set(recipients.map((item) => item.toLowerCase()))];

  if (unique.length === 0) {
    throw new PermanentSendError('Укажите хотя бы одного получателя');
  }

  const invalid = unique.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

  if (invalid.length) {
    throw new PermanentSendError(`${field}: недействительный адрес — ${invalid.join(', ')}. Укажите другой.`);
  }

  return unique;
}

// CC/BCC опциональны (US-11.2): пустое поле — это не ошибка, в отличие от
// пустого списка основных получателей.
function normalizeOptionalRecipients(input, field) {
  const hasValue = Array.isArray(input) ? input.length > 0 : String(input || '').trim().length > 0;
  return hasValue ? normalizeRecipients(input, { field }) : [];
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

// Названия проектов записи: с эпика 10 встреча живёт в нескольких проектах, а
// письмо до сих пор показывало только первый (recording.project).
function projectNames(recording) {
  const projects = recording.projects?.length ? recording.projects : recording.project ? [recording.project] : [];
  return projects.map((project) => project.name).join(', ') || 'без проекта';
}

/**
 * US-11.1: «Отправляем: протокол, краткое резюме, задачи» — payloadKind решает,
 * что попадёт в письмо/сообщение. 'protocol' — прежнее поведение (всё целиком),
 * поэтому он же и по умолчанию: старые вызовы не меняют смысла.
 */
function buildEmailContent(recording, message = '', payloadKind = 'protocol') {
  const summary = recording.summary;
  const protocol = summary?.protocol || {};
  const template = getProtocolTemplate(recording.meetingType);
  const intro = String(message || '').trim();
  const withSummary = payloadKind === 'protocol' || payloadKind === 'summary';
  const withProtocol = payloadKind === 'protocol';
  const withTasks = payloadKind === 'protocol' || payloadKind === 'tasks';

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
    `Проект: ${projectNames(recording)}`,
    `Статус: ${recording.status}`,
    '',
    ...(withSummary && summary?.executiveSummary ? ['## Executive summary', summary.executiveSummary, ''] : []),
    ...(withSummary ? ['## Резюме', summary?.summary || 'Резюме пока нет.', ''] : []),
    ...(withProtocol ? ['## Протокол', ...protocolTextBlocks] : []),
    ...(withTasks ? ['## Задачи', buildTasksText(recording.tasks)] : []),
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
          <strong>Проект:</strong> ${escapeHtml(projectNames(recording))}<br>
          <strong>Статус:</strong> ${escapeHtml(recording.status)}
        </p>
        ${withSummary && summary?.executiveSummary ? `<h2>Executive summary</h2><p>${escapeHtml(summary.executiveSummary).replace(/\n/g, '<br>')}</p>` : ''}
        ${withSummary ? `<h2>Резюме</h2><p>${escapeHtml(summary?.summary || 'Резюме пока нет.')}</p>` : ''}
        ${withProtocol ? `<h2>Протокол</h2>${protocolHtmlBlocks}` : ''}
        ${withTasks ? `<h2>Задачи</h2>${buildTasksHtml(recording.tasks)}` : ''}
      </body>
    </html>`;

  return { text, html };
}

// US-11.2: «тема/текст формируются автоматически» — тема зависит от того, что
// именно шлём, иначе письмо с одними задачами приходит с темой про протокол.
const SUBJECT_PREFIXES = {
  protocol: 'Протокол встречи',
  summary: 'Краткое резюме встречи',
  tasks: 'Задачи по встрече',
};

function buildSubject(recording, payloadKind) {
  return `${SUBJECT_PREFIXES[payloadKind] || SUBJECT_PREFIXES.protocol}: ${recording.title}`;
}

export { buildEmailContent, buildSubject };

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
  const payloadKind = PAYLOAD_KINDS.includes(input.payloadKind) ? input.payloadKind : 'protocol';
  const to = normalizeRecipients(input.recipients);
  const cc = normalizeOptionalRecipients(input.cc, 'Копия');
  const bcc = normalizeOptionalRecipients(input.bcc, 'Скрытая копия');
  const subject = String(input.subject || '').trim() || buildSubject(recording, payloadKind);
  const { text, html } = buildEmailContent(recording, input.message, payloadKind);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  const attachments = [];

  if (input.attachDocx) {
    const { filename, buffer } = await buildProtocolDocxBuffer(recording, payloadKind);
    attachments.push({ filename, content: buffer });
  }

  const result = await transporter.sendMail({
    from: config.from,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject,
    text,
    html,
    ...(attachments.length ? { attachments } : {}),
  });

  return {
    messageId: result.messageId,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
    cc,
    bcc,
    attached: attachments.map((item) => item.filename),
  };
}
