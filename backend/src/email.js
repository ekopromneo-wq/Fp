import nodemailer from 'nodemailer';

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
  const protocol = summary?.protocol;
  const intro = String(message || '').trim();
  const text = [
    intro,
    `# ${recording.title}`,
    '',
    `Файл: ${recording.originalFilename || 'не прикреплен'}`,
    `Проект: ${recording.project?.name || 'без проекта'}`,
    `Статус: ${recording.status}`,
    '',
    '## Резюме',
    summary?.summary || 'Резюме пока нет.',
    '',
    '## Протокол',
    '### Повестка',
    formatList(protocol?.agenda),
    '',
    '### Решения',
    formatList(protocol?.decisions),
    '',
    '### Риски',
    formatList(protocol?.risks),
    '',
    '## Задачи',
    buildTasksText(recording.tasks),
  ]
    .filter((item, index) => index !== 0 || item)
    .join('\n');

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
        <h2>Резюме</h2>
        <p>${escapeHtml(summary?.summary || 'Резюме пока нет.')}</p>
        <h2>Протокол</h2>
        <h3>Повестка</h3>
        ${formatHtmlList(protocol?.agenda)}
        <h3>Решения</h3>
        ${formatHtmlList(protocol?.decisions)}
        <h3>Риски</h3>
        ${formatHtmlList(protocol?.risks)}
        <h2>Задачи</h2>
        ${buildTasksHtml(recording.tasks)}
      </body>
    </html>`;

  return { text, html };
}

export { buildEmailContent };

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
