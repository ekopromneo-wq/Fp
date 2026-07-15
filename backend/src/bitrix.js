import { PermanentSendError } from './sending.js';

function getBitrixConfig(input = {}) {
  const webhookUrl = input.webhookUrl || process.env.BITRIX_WEBHOOK_URL;
  const defaultResponsibleId = input.defaultResponsibleId || process.env.BITRIX_DEFAULT_RESPONSIBLE_ID;
  const defaultGroupId = input.defaultGroupId || process.env.BITRIX_DEFAULT_GROUP_ID;

  if (!webhookUrl) {
    throw new PermanentSendError('Битрикс24 не настроен — укажите вебхук в настройках');
  }

  return {
    webhookUrl: webhookUrl.replace(/\/+$/, ''),
    defaultResponsibleId: defaultResponsibleId || null,
    defaultGroupId: defaultGroupId || null,
  };
}

function buildTaskDescription(recording, task) {
  return [
    `Встреча: ${recording.title}`,
    `Исполнитель из встречи: ${task.assignee || 'не указан'}`,
    `Срок из встречи: ${task.dueText || 'не указан'}`,
  ].join('\n');
}

async function createBitrixTask(config, recording, task) {
  if (!config.defaultResponsibleId) {
    throw new Error('Bitrix24 responsible user id is not configured');
  }

  const fields = {
    TITLE: task.description.slice(0, 250),
    DESCRIPTION: buildTaskDescription(recording, task),
    RESPONSIBLE_ID: config.defaultResponsibleId,
  };

  if (config.defaultGroupId) {
    fields.GROUP_ID = config.defaultGroupId;
  }

  const response = await fetch(`${config.webhookUrl}/tasks.task.add.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.error) {
    throw new Error(body?.error_description || body?.error || `Bitrix24 task.add failed with ${response.status}`);
  }

  const taskId = body?.result?.task?.id;

  if (!taskId) {
    throw new Error('Bitrix24 response is missing the created task id');
  }

  return taskId;
}

/**
 * Creates a Bitrix24 task per requested recording task. Returns per-task
 * results instead of throwing on individual failures, so one bad task
 * doesn't block the rest of the batch.
 */
export async function sendTasksToBitrix(recording, tasks, bitrixConfig = {}) {
  const config = getBitrixConfig(bitrixConfig);
  const results = [];

  for (const task of tasks) {
    try {
      const bitrixTaskId = await createBitrixTask(config, recording, task);
      results.push({ taskId: task.id, ok: true, bitrixTaskId });
    } catch (error) {
      results.push({ taskId: task.id, ok: false, error: error.message });
    }
  }

  return results;
}

const USER_PAGE_SIZE = 50;
const MAX_USER_PAGES = 20;

/**
 * Fetches Bitrix24 employees (name fields + email) via the incoming
 * webhook's user.get method. Includes deactivated/former employees too - a
 * speaker in an old recording may have left the company since, and their
 * name can still collide with a current employee's, which is exactly the
 * ambiguous case the caller needs to see. Requires the webhook to have the
 * "Пользователи" (user) access scope in addition to "Задачи".
 */
export async function fetchBitrixUsers(bitrixConfig = {}) {
  const config = getBitrixConfig(bitrixConfig);
  const users = [];

  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const start = page * USER_PAGE_SIZE;
    const response = await fetch(`${config.webhookUrl}/user.get.json?start=${start}`);
    const body = await response.json().catch(() => null);

    if (!response.ok || body?.error) {
      throw new Error(body?.error_description || body?.error || `Bitrix24 user.get failed with ${response.status}`);
    }

    const pageUsers = Array.isArray(body?.result) ? body.result : [];

    for (const user of pageUsers) {
      if (user.EMAIL) {
        users.push({
          id: user.ID,
          lastName: user.LAST_NAME || '',
          firstName: user.NAME || '',
          secondName: user.SECOND_NAME || '',
          email: user.EMAIL,
        });
      }
    }

    if (!body?.next || pageUsers.length < USER_PAGE_SIZE) {
      break;
    }
  }

  return users;
}

function normalizeNamePart(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Matches a diarized speaker's display name against Bitrix24 employees.
 * A candidate qualifies only when at least two of the employee's three name
 * fields (last name, first name, patronymic) are found among the words of
 * the speaker's name - a single shared first name is not enough to avoid
 * false positives on common names.
 */
export function matchSpeakerToBitrixUsers(speakerName, users) {
  const speakerWords = new Set(
    String(speakerName || '')
      .split(/\s+/)
      .map(normalizeNamePart)
      .filter(Boolean),
  );

  if (speakerWords.size < 2) {
    return [];
  }

  const candidates = [];

  for (const user of users) {
    const fields = [user.lastName, user.firstName, user.secondName].map(normalizeNamePart);
    const matchedFieldCount = fields.filter((field) => field && speakerWords.has(field)).length;

    if (matchedFieldCount >= 2) {
      const fullName = [user.lastName, user.firstName, user.secondName].filter(Boolean).join(' ');
      candidates.push({ id: user.id, name: fullName, email: user.email, matchedFieldCount });
    }
  }

  return candidates.sort((a, b) => b.matchedFieldCount - a.matchedFieldCount);
}

/**
 * Returns, per speaker label, the matching Bitrix24 candidates and an
 * autoMatch (the single unambiguous best match, if there's exactly one
 * candidate). Callers should auto-fill contact info only when autoMatch is
 * present, and otherwise let the user pick from candidates.
 */
export async function matchRecordingSpeakersToBitrix(speakers, bitrixConfig = {}) {
  const users = await fetchBitrixUsers(bitrixConfig);

  return speakers.map((speaker) => {
    const candidates = matchSpeakerToBitrixUsers(speaker.displayName, users);

    return {
      label: speaker.label,
      candidates,
      autoMatch: candidates.length === 1 ? candidates[0] : null,
    };
  });
}
