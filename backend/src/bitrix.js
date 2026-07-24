import { PermanentSendError } from './sending.js';
import { fetchPublicUrl, UnsafeUrlError } from './urlSafety.js';

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

async function callBitrix(config, method, payload) {
  let response;
  try {
    // Вебхук — адрес, который сам пользователь вписывает в настройках; без
    // проверки хоста это была бы SSRF-дыра во внутреннюю сеть сервера.
    response = await fetchPublicUrl(`${config.webhookUrl}/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new PermanentSendError('Вебхук Битрикс24 указывает на недопустимый адрес');
    }
    throw error;
  }
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.error) {
    const message = body?.error_description || body?.error || `Bitrix24 ${method} failed with ${response.status}`;

    // 4xx с текстом ошибки — вебхук отозван, права не выданы, поля не приняты:
    // повторять бессмысленно. 5xx — временное.
    if (response.status < 500) {
      throw new PermanentSendError(message);
    }

    throw new Error(message);
  }

  return body;
}

/**
 * Ссылка на созданную задачу (US-11.4: «сохраняем ссылку»). Портал берётся из
 * вебхука (https://portal.bitrix24.ru/rest/1/токен/ → https://portal.bitrix24.ru);
 * путь /company/personal/user/<ответственный>/tasks/task/view/<id>/ — штатный
 * адрес карточки задачи, Битрикс сам перенаправит, если задача в группе.
 */
export function buildBitrixTaskUrl(webhookUrl, responsibleId, taskId) {
  try {
    const origin = new URL(webhookUrl).origin;
    return `${origin}/company/personal/user/${responsibleId}/tasks/task/view/${taskId}/`;
  } catch {
    return null;
  }
}

async function createBitrixTask(config, recording, task, { responsibleId, groupId } = {}) {
  const resolvedResponsibleId = responsibleId || config.defaultResponsibleId;

  if (!resolvedResponsibleId) {
    throw new PermanentSendError('Сотрудник Битрикс24 не выбран — задача не отправлена');
  }

  const fields = {
    TITLE: task.description.slice(0, 250),
    DESCRIPTION: buildTaskDescription(recording, task),
    RESPONSIBLE_ID: resolvedResponsibleId,
  };
  const resolvedGroupId = groupId ?? config.defaultGroupId;

  if (resolvedGroupId) {
    fields.GROUP_ID = resolvedGroupId;
  }

  // US-9.3/11.4: срок уезжает в Б24, когда он распознан в дату.
  if (task.dueDate) {
    fields.DEADLINE = new Date(task.dueDate).toISOString();
  }

  const body = await callBitrix(config, 'tasks.task.add', { fields });
  const taskId = body?.result?.task?.id;

  if (!taskId) {
    throw new PermanentSendError('Bitrix24 response is missing the created task id');
  }

  return {
    bitrixTaskId: taskId,
    url: buildBitrixTaskUrl(config.webhookUrl, resolvedResponsibleId, taskId),
    responsibleId: String(resolvedResponsibleId),
    groupId: resolvedGroupId ? String(resolvedGroupId) : null,
  };
}

/**
 * Дубли (US-11.4: «Дубли → сообщение, решает пользователь»): ищем в Б24 живые
 * задачи с тем же названием. Точное совпадение TITLE — осознанно узкое
 * определение дубля: перефразированную задачу не поймает, зато не шумит на
 * каждой отправке.
 */
export async function findBitrixTaskDuplicates(bitrixConfig, title) {
  const config = getBitrixConfig(bitrixConfig);
  const body = await callBitrix(config, 'tasks.task.list', {
    filter: { TITLE: title.slice(0, 250) },
    select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID'],
  });
  const tasks = Array.isArray(body?.result?.tasks) ? body.result.tasks : [];

  return tasks.map((task) => ({
    id: String(task.id ?? task.ID),
    title: task.title ?? task.TITLE,
    url: buildBitrixTaskUrl(config.webhookUrl, task.responsibleId ?? task.RESPONSIBLE_ID ?? 0, task.id ?? task.ID),
  }));
}

/**
 * Группы (проекты) Битрикса — «Группу проекта выбирает пользователь» (US-11.4).
 * Требует у вебхука scope «Соцсеть» (sonet_group); без него честно бросаем
 * ошибку, UI покажет её и оставит ручной ввод id группы.
 */
export async function fetchBitrixGroups(bitrixConfig = {}) {
  const config = getBitrixConfig(bitrixConfig);
  const groups = [];

  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const body = await callBitrix(config, 'sonet_group.get', { start: page * USER_PAGE_SIZE });
    const pageGroups = Array.isArray(body?.result) ? body.result : [];

    for (const group of pageGroups) {
      groups.push({ id: String(group.ID), name: group.NAME });
    }

    if (!body?.next || pageGroups.length < USER_PAGE_SIZE) {
      break;
    }
  }

  return groups;
}

/**
 * Отправка одной задачи с явным выбором сотрудника и группы (US-11.4).
 * Проверка дублей — до создания; пользователь подтверждает отправку дубля
 * флагом confirmDuplicate.
 */
export async function sendTaskToBitrix(bitrixConfig, recording, task, { responsibleId, groupId } = {}) {
  const config = getBitrixConfig(bitrixConfig);
  return createBitrixTask(config, recording, task, { responsibleId, groupId });
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
      const created = await createBitrixTask(config, recording, task);
      results.push({ taskId: task.id, ok: true, bitrixTaskId: created.bitrixTaskId, url: created.url });
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
    let response;
    try {
      response = await fetchPublicUrl(`${config.webhookUrl}/user.get.json?start=${start}`);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new PermanentSendError('Вебхук Битрикс24 указывает на недопустимый адрес');
      }
      throw error;
    }
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

/**
 * US-11.4: «Сопоставление сотрудника Б24 — предлагается пользователю».
 * Кандидаты по исполнителю каждой задачи — тем же именным сопоставлением, что
 * у спикеров (совпадение минимум двух из трёх полей ФИО).
 */
export async function matchRecordingTasksToBitrix(tasks, bitrixConfig = {}) {
  const users = await fetchBitrixUsers(bitrixConfig);

  return tasks.map((task) => {
    const candidates = matchSpeakerToBitrixUsers(task.assignee, users);

    return {
      taskId: task.id,
      candidates,
      autoMatch: candidates.length === 1 ? candidates[0] : null,
    };
  });
}
