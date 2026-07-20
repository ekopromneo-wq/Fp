import { bodyLimit } from 'hono/body-limit';
import { createRecordingQueue } from './queue.js';
import {
  getAuthUser,
  getUserAccountConfig,
  getUserBitrixConfig,
  getUserDiarizationConfig,
  getUserSmtpConfig,
  getUserTelegramConfig,
  requireAuth,
} from './auth.js';
import { query, transaction } from './db.js';
import { track } from './analytics.js';
import { checkProcessingQuota, minutesFromSeconds } from './quota.js';
import { constantTimeEqual } from './oauth.js';
import { sendRecordingEmail, sendTaskEmail } from './email.js';
import { sendRecordingTelegram, sendTaskTelegram } from './telegram.js';
import { recordDelivery, sendWithRetry } from './sending.js';
import {
  fetchBitrixGroups,
  fetchBitrixUsers,
  findBitrixTaskDuplicates,
  matchRecordingSpeakersToBitrix,
  matchRecordingTasksToBitrix,
  sendTaskToBitrix,
  sendTasksToBitrix,
} from './bitrix.js';
import { matchRecordingSpeakersToContacts, matchRecordingTasksToContacts, isAssigneeExternal, listContacts } from './contacts.js';
import {
  MEETING_TYPES,
  PROTOCOL_ALL_SECTIONS,
  PROTOCOL_SECTION_LABELS,
  getProtocolTemplate,
} from './protocolTemplates.js';
import { joinMeeting, stopMeeting, isSupportedMeetingUrl } from './meetingBot.js';
import { detectPlatform, isSupportedMeetingUrl as isSelfHostedMeetingUrl, startRecorderJob, stopRecorderJob } from './recorderBot.js';
import { Readable } from 'node:stream';
import { deleteRecordingAudio, getRecordingAudioRange, getRecordingAudioStream, saveRecordingAudio, saveRecordingAudioFromPath } from './storage.js';
import { MAX_UPLOAD_BYTES, UploadValidationError, probeUploadedAudio, probeUploadedAudioPath } from './uploadValidation.js';
import { transcribeWithOpenRouter } from './openrouterAsr.js';
import { resolveDueDate } from './dueDateResolver.js';

const queue = createRecordingQueue();

// Only single-range "bytes=start-end"/"bytes=start-" requests are
// supported (exactly what browsers send for <audio> scrubbing) - multi-range
// and unrecognized units just fall back to a full 200 response.
function parseRangeHeader(headerValue, totalSize) {
  if (!headerValue || !totalSize) {
    return null;
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(headerValue.trim());

  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
    return null;
  }

  const clampedEnd = Math.min(end, totalSize - 1);

  return { offset: start, length: clampedEnd - start + 1 };
}

function mapRecording(row) {
  // recording_projects (m2m, US-10.1) is the source of truth; the legacy
  // recordings.project_id column is backfilled into it by migration 020 and
  // no longer written. projectId/project stay as "the first project" for
  // callers that predate multi-project (cards, offline cache).
  const projects = Array.isArray(row.projects) ? row.projects : [];

  return {
    id: row.id,
    ownerId: row.owner_id,
    projects,
    projectId: projects[0]?.id || null,
    project: projects[0] || null,
    title: row.title,
    status: row.status,
    source: row.source,
    meetingType: row.meeting_type || 'meeting',
    protocolTemplate: getProtocolTemplate(row.meeting_type),
    durationSeconds: row.duration_seconds,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    autoNamed: Boolean(row.auto_named),
    meetingUrl: row.meeting_url || null,
    meetingBotTaskId: row.meeting_bot_task_id || null,
    confidential: Boolean(row.confidential),
    downloadLocked: Boolean(row.download_locked),
    // US-2.3: известные имена/термины для ASR (только в detail-выборке).
    asrHints: row.asr_hints || null,
    deletedAt: row.deleted_at || null,
    recorderEngine: row.recorder_engine || null,
    failureCount: row.failure_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    color: row.color,
    description: row.description || null,
    isArchived: Boolean(row.archived_at),
    archivedAt: row.archived_at || null,
    members: Array.isArray(row.members) ? row.members : [],
    meetingsCount: row.meetings_count === undefined ? null : Number(row.meetings_count),
    openTasksCount: row.open_tasks_count === undefined ? null : Number(row.open_tasks_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Correlated subquery reused by every recording-returning select - keeps the
// m2m projects list in one shape everywhere without a separate round-trip.
const RECORDING_PROJECTS_SELECT = `
  (
    select json_agg(json_build_object('id', p.id, 'name', p.name, 'color', p.color) order by p.name)
    from recording_projects rp
    join projects p on p.id = rp.project_id
    where rp.recording_id = recordings.id
  ) as projects
`;

function mapJob(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    queueJobId: row.queue_job_id,
    status: row.status,
    error: row.error,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTranscript(row) {
  return row
    ? {
        id: row.id,
        recordingId: row.recording_id,
        jobId: row.job_id,
        language: row.language,
        text: row.text,
        segments: row.segments,
        originalText: row.original_text,
        originalSegments: row.original_segments,
        isLocked: Boolean(row.is_locked),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function summaryIsEdited(row) {
  const original = row.original_summary;

  if (!original || typeof original !== 'object') {
    return false;
  }

  const current = {
    summary: row.summary || '',
    executiveSummary: row.executive_summary || null,
    protocol: normalizeProtocol(row.protocol),
    topics: row.topics || [],
  };
  const snapshot = {
    summary: original.summary || '',
    executiveSummary: original.executiveSummary || null,
    protocol: normalizeProtocol(original.protocol),
    topics: original.topics || [],
  };

  return JSON.stringify(current) !== JSON.stringify(snapshot);
}

function mapSummary(row) {
  return row
    ? {
        id: row.id,
        recordingId: row.recording_id,
        transcriptId: row.transcript_id,
        model: row.model,
        summary: row.summary,
        executiveSummary: row.executive_summary || null,
        actionItems: row.action_items,
        topics: row.topics,
        protocol: normalizeProtocol(row.protocol),
        isLocked: Boolean(row.is_locked),
        isEdited: summaryIsEdited(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapTask(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    summaryId: row.summary_id,
    transcriptId: row.transcript_id,
    assignee: row.assignee,
    description: row.description,
    dueText: row.due_text,
    dueDate: row.due_date,
    assigneeExternal: Boolean(row.assignee_external),
    status: row.status,
    externalRefs: row.external_refs || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Неполная задача (NFR §6) — без исполнителя или без срока (то самое «?»).
// Работает и с mapTask-объектом, и с task из getRecording.
function isTaskIncomplete(task) {
  return !task?.assignee || !task?.dueText;
}

function mapSpeaker(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    label: row.label,
    displayName: row.display_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    suggestedName: row.suggested_name || null,
    suggestionConfidence: row.suggestion_confidence || null,
    suggestionEvidence: row.suggestion_evidence || null,
    suggestionStatus: row.suggestion_status || 'none',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatSpeakerLabel(label) {
  const normalized = String(label || 'speaker_1').trim() || 'speaker_1';
  const match = normalized.match(/^speaker[_ -]?(\d+)$/i);

  return match ? `Спикер ${match[1]}` : normalized;
}

function extractSpeakerLabels(segments) {
  const labels = new Set();
  const items = Array.isArray(segments) ? segments : [];

  for (const segment of items) {
    const label = typeof segment?.speaker === 'string' ? segment.speaker.trim() : '';

    if (label) {
      labels.add(label);
    }
  }

  return [...labels].sort((a, b) => a.localeCompare(b));
}

function mergeSpeakers(transcriptRow, speakerRows) {
  const storedSpeakers = speakerRows.map(mapSpeaker);
  const storedByLabel = new Map(storedSpeakers.map((speaker) => [speaker.label, speaker]));
  const labels = transcriptRow ? extractSpeakerLabels(transcriptRow.segments) : [];

  if (transcriptRow && labels.length === 0) {
    labels.push('speaker_1');
  }

  for (const label of labels) {
    if (!storedByLabel.has(label)) {
      storedByLabel.set(label, {
        id: null,
        recordingId: transcriptRow.recording_id,
        label,
        displayName: formatSpeakerLabel(label),
        contactName: null,
        contactEmail: null,
        suggestedName: null,
        suggestionConfidence: null,
        suggestionEvidence: null,
        suggestionStatus: 'none',
        createdAt: null,
        updatedAt: null,
      });
    }
  }

  return [...storedByLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeProtocolSection(sectionKey, value) {
  const items = Array.isArray(value) ? value : [];

  if (sectionKey === 'decisions') {
    return items
      .map((item) => {
        if (item && typeof item === 'object') {
          const text = String(item.text || '').trim();
          return text ? { text, disputed: Boolean(item.disputed) } : null;
        }

        const text = String(item || '').trim();
        return text ? { text, disputed: false } : null;
      })
      .filter(Boolean);
  }

  return items.map((item) => String(item || '').trim()).filter(Boolean);
}

// Always normalizes to the full section superset (empty arrays for sections
// not part of the record's own template) so mapSummary/isEdited comparisons
// have a uniform shape regardless of which template generated the row - the
// UI picks which keys to actually render via getProtocolTemplate(meetingType).
function normalizeProtocol(input) {
  const protocol = input && typeof input === 'object' ? input : {};
  const normalized = {};

  for (const key of PROTOCOL_ALL_SECTIONS) {
    normalized[key] = normalizeProtocolSection(key, protocol[key]);
  }

  return normalized;
}

function normalizeTask(input) {
  if (typeof input === 'string') {
    const description = input.trim();
    return description ? { assignee: null, description, dueText: null } : null;
  }

  if (!input || typeof input !== 'object') {
    return null;
  }

  const description = String(input.description || input.action || input.task || '').trim();

  if (!description) {
    return null;
  }

  return {
    assignee: input.assignee || input.owner || input.who ? String(input.assignee || input.owner || input.who).trim() : null,
    description,
    dueText: input.dueText || input.deadline || input.when ? String(input.dueText || input.deadline || input.when).trim() : null,
  };
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }

    throw new Error('LLM response is not valid JSON');
  }
}

const SUMMARY_LENGTHS = new Set(['brief', 'medium', 'long']);

const SUMMARY_LENGTH_INSTRUCTIONS = {
  brief: 'Длина: очень кратко. summary — 2-3 предложения с самой сутью. executiveSummary — 3 строки. protocol и tasks — только самое важное (максимум по 3 пункта в каждом разделе protocol).',
  medium: 'Длина: средняя. summary — 1-3 абзаца. executiveSummary — 3-5 строк. protocol — по несколько пунктов на раздел. tasks — все явно упомянутые задачи.',
  long: 'Длина: подробная. summary — ОБЯЗАТЕЛЬНО не менее 4-6 абзацев (от 300 слов), пересказывающих ход обсуждения по порядку: кто что поднял, какие аргументы приводились, к чему пришли. Не сокращай и не обобщай в одно предложение. executiveSummary остаётся коротким (3-5 строк) даже при подробном summary. protocol — детальный разбор по каждому разделу, ничего не упускай. tasks — все задачи с максимальной детализацией (кто, что, когда, в каком контексте это прозвучало).',
};

function normalizeSummaryLength(length) {
  return SUMMARY_LENGTHS.has(length) ? length : 'medium';
}

async function generateSummaryWithOpenRouter(
  transcriptText,
  { length = 'medium', meetingType = 'meeting', instruction = '', speakers = [], dueDateAnchor = null, timezoneOffsetMinutes = 0 } = {},
) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const summaryLength = normalizeSummaryLength(length);
  const template = getProtocolTemplate(meetingType);
  const model = process.env.OPENROUTER_LLM_MODEL || 'openai/gpt-4o-mini';
  const sectionDescriptions = template.sections
    .map((key) =>
      key === 'decisions'
        ? `- decisions: массив объектов {text:string, disputed:boolean} — "${PROTOCOL_SECTION_LABELS[key]}". disputed=true, если решение прозвучало неуверенно или не было явно подтверждено всеми участниками`
        : `- ${key}: string[] — "${PROTOCOL_SECTION_LABELS[key]}"`,
    )
    .join('\n');
  const instructionLine = instruction && String(instruction).trim()
    ? `\n\nДополнительное указание пользователя (обязательно учти при генерации): ${String(instruction).trim()}`
    : '';
  // Real display names, where already resolved (epic 7's speaker
  // accept/reject flow), let the LLM address "мы сделаем"/"я возьму на
  // себя" self-references by real name instead of a positional label like
  // "Спикер 1" - the identities already exist by generation time, nothing
  // new is computed here.
  const knownSpeakers = speakers
    .filter((speaker) => speaker.displayName && speaker.displayName !== speaker.label)
    .map((speaker) => `${speaker.label} = ${speaker.displayName}`);
  const speakersLine = knownSpeakers.length
    ? `\n\nИзвестные имена участников (используй их вместо позиционных меток в поле assignee, если задача поручена этому человеку): ${knownSpeakers.join(', ')}.`
    : '';

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'Stenogram',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `Ты помощник Stenogram. Верни строго JSON без markdown. Поля: summary:string (полная версия), executiveSummary:string (краткая выжимка сути встречи, 3-5 строк), topics:string[], protocol:{${template.sections.join(',')}}, tasks:{assignee:string|null,description:string,dueText:string|null}[]. ` +
            `Разделы protocol (используй только перечисленные ниже, больше никаких других полей в protocol не добавляй):\n${sectionDescriptions}\n\n` +
            'Пиши по-русски, конкретно. Если исполнитель или срок не названы явно, ставь null - не выдумывай. ' +
            'Одна реплика может дать несколько задач. Если два фрагмента речи описывают одно и то же поручение - верни одну задачу, не дублируй. ' +
            'Приоритет — точность: лучше не создать задачу, чем создать ложную.' +
            speakersLine + '\n\n' +
            SUMMARY_LENGTH_INSTRUCTIONS[summaryLength] +
            instructionLine,
        },
        {
          role: 'user',
          content: `Сделай структурированный протокол стенограммы (шаблон: ${template.label}) и извлеки задачи в формате кто-что-когда.\n\nСтенограмма:\n${transcriptText}`,
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `OpenRouter LLM failed with ${response.status}`);
  }

  const content = body?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : parsed.actionItems || [])
    .map(normalizeTask)
    .filter(Boolean)
    .map((task) => ({
      ...task,
      dueDate: dueDateAnchor ? resolveDueDate(task.dueText, dueDateAnchor, timezoneOffsetMinutes) : null,
    }));

  return {
    model,
    summary: String(parsed.summary || '').trim(),
    executiveSummary: String(parsed.executiveSummary || '').trim(),
    actionItems: tasks.map((task) => task.description),
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
    protocol: normalizeProtocol(parsed.protocol),
    tasks,
  };
}

async function generateTitleWithOpenRouter(recording) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const model = process.env.OPENROUTER_LLM_MODEL || 'openai/gpt-4o-mini';
  const speakers = (recording.speakers || [])
    .map((speaker) => speaker.displayName || speaker.label)
    .filter(Boolean)
    .join(', ');
  const summary = recording.summary?.summary || '';
  const transcript = recording.transcript?.text || '';

  if (!summary && !transcript) {
    throw new Error('Recording has no transcript or summary yet');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'Stenogram',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник Stenogram. Верни строго JSON без markdown с полем title:string. Название должно быть по-русски, короткое, 4-9 слов, без кавычек, без даты если дата не дана явно.',
        },
        {
          role: 'user',
          content: `Предложи понятное название встречи по материалам.\n\nТекущее название: ${recording.title}\nСпикеры: ${speakers || 'не указаны'}\nРезюме: ${summary || 'нет'}\nСтенограмма:\n${transcript.slice(0, 6000)}`,
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `OpenRouter LLM failed with ${response.status}`);
  }

  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content);
  const title = String(parsed.title || '').trim();

  if (!title) {
    throw new Error('LLM did not return a title');
  }

  return title.slice(0, 160);
}

const PROJECT_SELECT = `
  select
    projects.id, projects.owner_id, projects.name, projects.color, projects.description,
    projects.archived_at, projects.created_at, projects.updated_at,
    (
      select count(*)::int
      from recording_projects rp
      where rp.project_id = projects.id
    ) as meetings_count,
    (
      select count(*)::int
      from recording_tasks t
      join recording_projects rp on rp.recording_id = t.recording_id
      where rp.project_id = projects.id
        and t.status in ('extracted', 'confirmed', 'sent')
    ) as open_tasks_count,
    coalesce(
      (
        select json_agg(json_build_object('id', m.id, 'contactId', m.contact_id, 'name', m.display_name) order by m.created_at)
        from project_members m
        where m.project_id = projects.id
      ),
      '[]'::json
    ) as members
  from projects
`;

export async function listProjects(ownerId) {
  const result = await query(
    `
      ${PROJECT_SELECT}
      where owner_id = $1
      order by name asc
    `,
    [ownerId],
  );

  return result.rows.map(mapProject);
}

export async function getProject(projectId, ownerId) {
  const result = await query(
    `
      ${PROJECT_SELECT}
      where projects.id = $1 and owner_id = $2
    `,
    [projectId, ownerId],
  );

  return result.rowCount ? mapProject(result.rows[0]) : null;
}

// Participants carry no access rights in MVP (access groups are explicitly
// out of scope per US-10.1) - they're an informational list, optionally
// linked to a contact so the name survives contact deletion via display_name.
function normalizeProjectMembers(participants) {
  if (!Array.isArray(participants)) {
    return [];
  }

  return participants
    .map((participant) => ({
      contactId: typeof participant?.contactId === 'string' && participant.contactId.trim() ? participant.contactId.trim() : null,
      name: typeof participant?.name === 'string' ? participant.name.trim() : '',
    }))
    .filter((participant) => participant.name);
}

async function replaceProjectMembers(client, projectId, members) {
  await client.query('delete from project_members where project_id = $1', [projectId]);

  for (const member of members) {
    await client.query('insert into project_members (project_id, contact_id, display_name) values ($1, $2, $3)', [
      projectId,
      member.contactId,
      member.name,
    ]);
  }
}

export async function createProject(input, ownerId) {
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '';
  const color = typeof input.color === 'string' && input.color.trim() ? input.color.trim() : '#235b4f';
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null;
  const members = normalizeProjectMembers(input.participants);

  if (!name) {
    throw new Error('Project name is required');
  }

  const projectId = await transaction(async (client) => {
    const result = await client.query(
      `
        insert into projects (owner_id, name, color, description)
        values ($1, $2, $3, $4)
        returning id
      `,
      [ownerId, name, color, description],
    );

    if (members.length) {
      await replaceProjectMembers(client, result.rows[0].id, members);
    }

    return result.rows[0].id;
  });

  return getProject(projectId, ownerId);
}

export async function updateProject(projectId, ownerId, input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const hasName = Object.prototype.hasOwnProperty.call(data, 'name');
  const hasColor = Object.prototype.hasOwnProperty.call(data, 'color');
  const hasDescription = Object.prototype.hasOwnProperty.call(data, 'description');
  const hasArchived = Object.prototype.hasOwnProperty.call(data, 'archived');
  const hasParticipants = Object.prototype.hasOwnProperty.call(data, 'participants');
  const name = hasName && typeof data.name === 'string' ? data.name.trim() : null;
  const color = hasColor && typeof data.color === 'string' && data.color.trim() ? data.color.trim() : null;
  const description = hasDescription && typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null;

  if (hasName && !name) {
    throw new Error('Project name is required');
  }

  const updated = await transaction(async (client) => {
    const result = await client.query(
      `
        update projects
        set
          name = case when $3 then $4 else projects.name end,
          color = case when $5 then $6 else projects.color end,
          description = case when $7 then $8 else projects.description end,
          archived_at = case
            when not $9 then projects.archived_at
            when $10 then coalesce(projects.archived_at, now())
            else null
          end,
          updated_at = now()
        where projects.id = $1 and projects.owner_id = $2
        returning id
      `,
      [projectId, ownerId, hasName, name, hasColor, color, hasDescription, description, hasArchived, Boolean(data.archived)],
    );

    if (result.rowCount === 0) {
      return false;
    }

    if (hasParticipants) {
      await replaceProjectMembers(client, projectId, normalizeProjectMembers(data.participants));
    }

    return true;
  });

  return updated ? getProject(projectId, ownerId) : null;
}

// US-10.1 / ADR-030: deleting a project must NOT delete its meetings - the
// recording_projects rows cascade away and the recordings become "Без
// проекта". The legacy recordings.project_id FK is on delete set null,
// covering pre-migration rows too.
export async function deleteProject(projectId, ownerId) {
  const result = await query('delete from projects where id = $1 and owner_id = $2 returning id', [
    projectId,
    ownerId,
  ]);

  return result.rowCount ? { id: projectId } : null;
}

// Decisions live inside recording_summaries.protocol->'decisions' as either
// plain strings (pre-epic-8 rows) or {text, disputed} objects - normalize
// both into the timeline shape.
export async function getProjectSummary(projectId, ownerId) {
  const project = await getProject(projectId, ownerId);

  if (!project) {
    return null;
  }

  const [recordings, openTasksResult, decisionsResult, doneTasksResult] = await Promise.all([
    listRecordings(ownerId, { projectId }),
    query(
      `
        select t.id, t.recording_id, t.summary_id, t.transcript_id, t.assignee, t.description, t.due_text,
          t.due_date, t.assignee_external, t.status, t.external_refs, t.created_at, t.updated_at,
          r.title as recording_title
        from recording_tasks t
        join recordings r on r.id = t.recording_id
        join recording_projects rp on rp.recording_id = t.recording_id and rp.project_id = $1
        where r.owner_id = $2
          and t.status in ('extracted', 'confirmed', 'sent')
        order by t.due_date asc nulls last, t.created_at desc
      `,
      [projectId, ownerId],
    ),
    query(
      `
        select r.id as recording_id, r.title as recording_title, r.created_at as recording_created_at, d.value as decision
        from recordings r
        join recording_projects rp on rp.recording_id = r.id and rp.project_id = $1
        join recording_summaries s on s.recording_id = r.id
        cross join lateral jsonb_array_elements(s.protocol->'decisions') as d(value)
        where r.owner_id = $2
          and jsonb_typeof(s.protocol->'decisions') = 'array'
        order by r.created_at desc
      `,
      [projectId, ownerId],
    ),
    query(
      `
        select count(*)::int as done_count
        from recording_tasks t
        join recordings r on r.id = t.recording_id
        join recording_projects rp on rp.recording_id = t.recording_id and rp.project_id = $1
        where r.owner_id = $2 and t.status = 'done'
      `,
      [projectId, ownerId],
    ),
  ]);

  const openTasks = openTasksResult.rows.map((row) => ({ ...mapTask(row), recordingTitle: row.recording_title }));
  const decisions = decisionsResult.rows.map((row) => {
    const raw = row.decision;
    const isObject = raw && typeof raw === 'object';

    return {
      text: isObject ? String(raw.text || '') : String(raw || ''),
      disputed: isObject ? Boolean(raw.disputed) : false,
      recordingId: row.recording_id,
      recordingTitle: row.recording_title,
      date: row.recording_created_at,
    };
  });

  return {
    project,
    recordings,
    openTasks,
    decisions: decisions.filter((decision) => decision.text),
    counters: {
      meetings: recordings.length,
      openTasks: openTasks.length,
      doneTasks: doneTasksResult.rows[0].done_count,
      decisions: decisions.length,
    },
  };
}

function cleanFilterString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// yyyy-mm-dd from <input type="date"> - anything else is ignored rather than
// passed into a ::date cast that would throw on garbage query params.
function cleanFilterDate(value) {
  const cleaned = cleanFilterString(value);
  return cleaned && /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? cleaned : null;
}

export async function listRecordings(ownerId, filters = {}) {
  const params = [ownerId];
  // US-16.4: корзина. По умолчанию удалённые скрыты; trash=only показывает
  // только корзину.
  const conditions = ['recordings.owner_id = $1', filters.trash === 'only' ? 'recordings.deleted_at is not null' : 'recordings.deleted_at is null'];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const search = cleanFilterString(filters.search);
  if (search) {
    const p = bind(search);
    conditions.push(`(
      recordings.title ilike '%' || ${p} || '%'
      or recordings.original_filename ilike '%' || ${p} || '%'
      or exists (
        select 1
        from recording_projects rp
        join projects p2 on p2.id = rp.project_id
        where rp.recording_id = recordings.id and p2.name ilike '%' || ${p} || '%'
      )
      or exists (
        select 1
        from transcripts
        where transcripts.recording_id = recordings.id
          and transcripts.text ilike '%' || ${p} || '%'
      )
    )`);
  }

  const projectId = cleanFilterString(filters.projectId);
  if (projectId) {
    conditions.push(
      `exists (select 1 from recording_projects rp where rp.recording_id = recordings.id and rp.project_id = ${bind(projectId)}::uuid)`,
    );
  }

  const dateFrom = cleanFilterDate(filters.dateFrom);
  if (dateFrom) {
    conditions.push(`recordings.created_at >= ${bind(dateFrom)}::date`);
  }

  const dateTo = cleanFilterDate(filters.dateTo);
  if (dateTo) {
    conditions.push(`recordings.created_at < ${bind(dateTo)}::date + interval '1 day'`);
  }

  const status = cleanFilterString(filters.status);
  if (status) {
    conditions.push(`recordings.status = ${bind(status)}`);
  }

  // The UI offers one "бот на встрече" option covering both bot flows.
  const source = cleanFilterString(filters.source);
  if (source === 'bot') {
    conditions.push(`recordings.source in ('meeting_bot', 'recorder_bot')`);
  } else if (source) {
    conditions.push(`recordings.source = ${bind(source)}`);
  }

  const meetingType = cleanFilterString(filters.meetingType);
  if (meetingType && MEETING_TYPES.has(meetingType)) {
    conditions.push(`recordings.meeting_type = ${bind(meetingType)}`);
  }

  const participant = cleanFilterString(filters.participant);
  if (participant) {
    const p = bind(participant);
    conditions.push(`exists (
      select 1
      from recording_speakers sp
      where sp.recording_id = recordings.id
        and (sp.display_name ilike '%' || ${p} || '%' or sp.contact_name ilike '%' || ${p} || '%')
    )`);
  }

  const hasTasks = cleanFilterString(filters.hasTasks);
  if (hasTasks === 'yes' || hasTasks === 'no') {
    const taskExists = `exists (select 1 from recording_tasks t where t.recording_id = recordings.id and t.status <> 'dismissed')`;
    conditions.push(hasTasks === 'yes' ? taskExists : `not ${taskExists}`);
  }

  const result = await query(
    `
      select
        recordings.id, recordings.owner_id, recordings.title, recordings.status,
        recordings.source, recordings.duration_seconds, recordings.storage_key, recordings.created_at,
        recordings.updated_at, recordings.original_filename, recordings.mime_type, recordings.file_size_bytes,
        recordings.auto_named, recordings.meeting_url, recordings.meeting_bot_task_id, recordings.failure_count,
        recordings.meeting_type, recordings.confidential, recordings.download_locked, recordings.deleted_at,
        ${RECORDING_PROJECTS_SELECT}
      from recordings
      where ${conditions.join('\n        and ')}
      order by recordings.created_at desc
      limit 50
    `,
    params,
  );

  return result.rows.map(mapRecording);
}

// US-10.2: cross-recording task search - one text query over assignee +
// description, plus due-date range / status / project narrowing. Returns the
// owning recording's title so results can link back to the meeting.
export async function searchTasks(ownerId, filters = {}) {
  const params = [ownerId];
  const conditions = [`r.owner_id = $1`, `t.status <> 'dismissed'`];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const search = cleanFilterString(filters.search);
  if (search) {
    const p = bind(search);
    conditions.push(`(t.description ilike '%' || ${p} || '%' or t.assignee ilike '%' || ${p} || '%')`);
  }

  const status = cleanFilterString(filters.status);
  if (status) {
    conditions.push(`t.status = ${bind(status)}`);
  }

  const projectId = cleanFilterString(filters.projectId);
  if (projectId) {
    conditions.push(`exists (select 1 from recording_projects rp where rp.recording_id = t.recording_id and rp.project_id = ${bind(projectId)}::uuid)`);
  }

  const dueFrom = cleanFilterDate(filters.dueFrom);
  if (dueFrom) {
    conditions.push(`t.due_date >= ${bind(dueFrom)}::date`);
  }

  const dueTo = cleanFilterDate(filters.dueTo);
  if (dueTo) {
    conditions.push(`t.due_date < ${bind(dueTo)}::date + interval '1 day'`);
  }

  const result = await query(
    `
      select t.id, t.recording_id, t.summary_id, t.transcript_id, t.assignee, t.description, t.due_text,
        t.due_date, t.assignee_external, t.status, t.external_refs, t.created_at, t.updated_at,
        r.title as recording_title, r.created_at as recording_created_at
      from recording_tasks t
      join recordings r on r.id = t.recording_id
      where ${conditions.join('\n        and ')}
      order by t.due_date asc nulls last, t.created_at desc
      limit 100
    `,
    params,
  );

  return result.rows.map((row) => ({
    ...mapTask(row),
    recordingTitle: row.recording_title,
    recordingCreatedAt: row.recording_created_at,
  }));
}

export async function createRecording(input, ownerId) {
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled recording';
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'manual';
  // US-16.2: тип встречи (шаблон протокола) по умолчанию — из настроек аккаунта,
  // если не задан явно.
  const accountConfig = ownerId ? await getUserAccountConfig(ownerId) : null;
  const meetingType = MEETING_TYPES.has(input.meetingType)
    ? input.meetingType
    : accountConfig?.defaultMeetingType && MEETING_TYPES.has(accountConfig.defaultMeetingType)
      ? accountConfig.defaultMeetingType
      : 'meeting';

  const result = await query(
    `
      insert into recordings (owner_id, title, source, duration_seconds, storage_key, meeting_type)
      values ($1, $2, $3, $4, $5, $6)
      returning id, owner_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, auto_named, meeting_type, created_at, updated_at,
        null as projects
    `,
    [ownerId, title, source, input.durationSeconds || null, input.storageKey || null, meetingType],
  );

  const recording = mapRecording(result.rows[0]);
  track('recording_created', { userId: ownerId, recordingId: recording.id, props: { source } });
  return recording;
}

/**
 * Sends the Speech2Text bot to join a live meeting (Zoom/Meet/Telemost/etc)
 * and creates a text-only recording that fills in once the bot finishes -
 * there's no audio file to attach, since the bot records on Speech2Text's
 * own infrastructure. A background poller in the worker (see worker.js)
 * checks progress and ingests the transcript when the task completes.
 */
export async function createMeetingBotRecording(input, ownerId) {
  const meetingUrl = typeof input.meetingUrl === 'string' ? input.meetingUrl.trim() : '';

  if (!meetingUrl) {
    throw new Error('Meeting URL is required');
  }

  if (!isSupportedMeetingUrl(meetingUrl)) {
    throw new Error('Meeting URL is not a supported conference platform');
  }

  const diarizationConfig = (await getUserDiarizationConfig(ownerId)) || {};
  const apiKey = diarizationConfig.speech2textApiKey || process.env.SPEECH2TEXT_API_KEY;

  if (!apiKey) {
    throw new Error('Speech2Text is not configured');
  }

  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Встреча по ссылке';

  const inserted = await query(
    `
      insert into recordings (owner_id, title, source, status, meeting_url)
      values ($1, $2, 'meeting_bot', 'queued', $3)
      returning id
    `,
    [ownerId, title, meetingUrl],
  );
  const recordingId = inserted.rows[0].id;

  try {
    const task = await joinMeeting(
      {
        meetingUrl,
        title,
        lang: input.lang,
        speakers: input.speakers,
        botName: input.botName,
        accessCode: input.accessCode,
      },
      apiKey,
    );

    await transaction(async (client) => {
      await client.query('update recordings set meeting_bot_task_id = $1, status = $2, updated_at = now() where id = $3', [
        task.id,
        'processing',
        recordingId,
      ]);
      await client.query(
        `insert into processing_jobs (recording_id, queue_job_id, status) values ($1, $2, 'processing')`,
        [recordingId, task.id],
      );
    });
  } catch (error) {
    await query('update recordings set status = $1, updated_at = now() where id = $2', ['failed', recordingId]);
    throw error;
  }

  return getRecording(recordingId, ownerId);
}

export async function stopMeetingBotRecording(recordingId, ownerId) {
  const result = await query(
    'select meeting_bot_task_id from recordings where id = $1 and owner_id = $2',
    [recordingId, ownerId],
  );
  const taskId = result.rows[0]?.meeting_bot_task_id;

  if (!taskId) {
    return null;
  }

  const diarizationConfig = (await getUserDiarizationConfig(ownerId)) || {};
  const apiKey = diarizationConfig.speech2textApiKey || process.env.SPEECH2TEXT_API_KEY;

  if (!apiKey) {
    throw new Error('Speech2Text is not configured');
  }

  await stopMeeting(taskId, apiKey);

  await transaction(async (client) => {
    await client.query('update recordings set status = $1, updated_at = now() where id = $2', ['failed', recordingId]);
    await client.query(
      `
        update processing_jobs
        set status = 'failed', error = 'Остановлено пользователем', updated_at = now()
        where recording_id = $1 and status = 'processing'
      `,
      [recordingId],
    );
  });

  return getRecording(recordingId, ownerId);
}

/**
 * Sends our own recorder-bot (Playwright + OS-level audio capture, no third
 * party involved) to join a live meeting on a platform we can operate
 * ourselves (currently: Yandex Telemost). Once the meeting ends, the bot
 * uploads the finished audio file to our /api/internal/recorder-bot/callback
 * route, which hands it to the same file-based diarization pipeline as a
 * manual upload - see attachRecordingAudio/enqueueRecording below.
 */
export async function createSelfHostedMeetingRecording(input, ownerId) {
  const meetingUrl = typeof input.meetingUrl === 'string' ? input.meetingUrl.trim() : '';
  const platform = detectPlatform(meetingUrl);

  if (!platform) {
    throw new Error('Meeting URL is not supported by the self-hosted recorder yet');
  }

  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Встреча по ссылке';

  const inserted = await query(
    `
      insert into recordings (owner_id, title, source, status, meeting_url, recorder_engine)
      values ($1, $2, 'recorder_bot', 'queued', $3, 'self_hosted')
      returning id
    `,
    [ownerId, title, meetingUrl],
  );
  const recordingId = inserted.rows[0].id;

  try {
    const job = await startRecorderJob({
      recordingId,
      meetingUrl,
      title,
      platform,
      botName: input.botName,
    });

    await transaction(async (client) => {
      await client.query('update recordings set meeting_bot_task_id = $1, status = $2, updated_at = now() where id = $3', [
        job.jobId,
        'processing',
        recordingId,
      ]);
      await client.query(
        `insert into processing_jobs (recording_id, queue_job_id, status) values ($1, $2, 'processing')`,
        [recordingId, job.jobId],
      );
    });
  } catch (error) {
    await query('update recordings set status = $1, updated_at = now() where id = $2', ['failed', recordingId]);
    throw error;
  }

  return getRecording(recordingId, ownerId);
}

export async function stopSelfHostedMeetingRecording(recordingId, ownerId) {
  const result = await query(
    'select meeting_bot_task_id from recordings where id = $1 and owner_id = $2 and recorder_engine = $3',
    [recordingId, ownerId, 'self_hosted'],
  );
  const jobId = result.rows[0]?.meeting_bot_task_id;

  if (!jobId) {
    return null;
  }

  await stopRecorderJob(jobId);

  return getRecording(recordingId, ownerId);
}

/**
 * Called by the recorder-bot service once a self-hosted meeting recording
 * has finished (or failed). Reuses the exact same attach+enqueue path as a
 * manual file upload, so the diarization pipeline needs no changes.
 */
export async function completeSelfHostedMeetingRecording(recordingId, file, errorMessage) {
  const result = await query('select owner_id from recordings where id = $1', [recordingId]);
  const ownerId = result.rows[0]?.owner_id;

  if (result.rowCount === 0) {
    return null;
  }

  if (errorMessage || !file) {
    await transaction(async (client) => {
      await client.query('update recordings set status = $1, updated_at = now() where id = $2', ['failed', recordingId]);
      await client.query(
        `
          update processing_jobs
          set status = 'failed', error = $1, updated_at = now()
          where recording_id = $2 and status = 'processing'
        `,
        [errorMessage || 'Recorder-bot did not return an audio file', recordingId],
      );
    });

    return getRecording(recordingId, ownerId);
  }

  try {
    await attachRecordingAudio(recordingId, file, ownerId);
  } catch (error) {
    if (!(error instanceof UploadValidationError)) {
      throw error;
    }

    await transaction(async (client) => {
      await client.query('update recordings set status = $1, updated_at = now() where id = $2', ['failed', recordingId]);
      await client.query(
        `
          update processing_jobs
          set status = 'failed', error = $1, updated_at = now()
          where recording_id = $2 and status = 'processing'
        `,
        [error.message, recordingId],
      );
    });

    return getRecording(recordingId, ownerId);
  }

  await enqueueRecording(recordingId, ownerId);

  return getRecording(recordingId, ownerId);
}

export async function getRecording(id, ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at
      , original_filename, mime_type, file_size_bytes, auto_named, meeting_url, meeting_bot_task_id,
        recorder_engine, failure_count, meeting_type, confidential, download_locked, asr_hints, deleted_at,
        ${RECORDING_PROJECTS_SELECT}
      from recordings
      where id = $1 and owner_id = $2
    `,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const [jobs, transcript, summary, tasks, speakers] = await Promise.all([
    query(
      `
        select id, recording_id, queue_job_id, status, error, cancel_requested, created_at, updated_at
        from processing_jobs
        where recording_id = $1
        order by created_at desc
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, job_id, language, text, segments, original_text, original_segments, is_locked, created_at, updated_at
        from transcripts
        where recording_id = $1
        order by created_at desc
        limit 1
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, transcript_id, model, summary, executive_summary, action_items, topics, protocol,
          original_summary, is_locked, created_at, updated_at
        from recording_summaries
        where recording_id = $1
        order by created_at desc
        limit 1
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
          assignee_external, status, external_refs, created_at, updated_at
        from recording_tasks
        where recording_id = $1 and status <> 'dismissed'
        order by created_at asc
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, label, display_name, contact_name, contact_email,
          suggested_name, suggestion_confidence, suggestion_evidence, suggestion_status, created_at, updated_at
        from recording_speakers
        where recording_id = $1
        order by label asc
      `,
      [id],
    ),
  ]);

  const transcriptRow = transcript.rows[0];

  return {
    ...mapRecording(result.rows[0]),
    jobs: jobs.rows.map(mapJob),
    transcript: mapTranscript(transcriptRow),
    summary: mapSummary(summary.rows[0]),
    tasks: tasks.rows.map(mapTask),
    speakers: mergeSpeakers(transcriptRow, speakers.rows),
  };
}

export async function summarizeRecording(recordingId, ownerId, { length = 'medium', instruction = '', timezoneOffsetMinutes = 0 } = {}) {
  const recording = await getRecording(recordingId, ownerId);

  if (!recording) {
    return null;
  }

  if (!recording.transcript?.text) {
    throw new Error('Recording has no transcript yet');
  }

  if (recording.summary?.isLocked) {
    throw new Error('Protocol is locked - unlock it before regenerating');
  }

  const generated = await generateSummaryWithOpenRouter(recording.transcript.text, {
    length,
    meetingType: recording.meetingType,
    instruction,
    speakers: recording.speakers || [],
    dueDateAnchor: recording.createdAt ? new Date(recording.createdAt) : new Date(),
    timezoneOffsetMinutes,
  });
  const originalSnapshot = JSON.stringify({
    summary: generated.summary,
    executiveSummary: generated.executiveSummary,
    protocol: generated.protocol,
    topics: generated.topics,
  });

  const result = await transaction(async (client) => {
    // No version history is kept (US-8.2: "старая версия затирается") - each
    // (re)generation replaces the row outright rather than accumulating one
    // row per call the way the old code incidentally did.
    await client.query('delete from recording_summaries where recording_id = $1', [recordingId]);

    const result = await client.query(
      `
        insert into recording_summaries
          (recording_id, transcript_id, model, summary, executive_summary, action_items, topics, protocol, original_summary)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
        returning id, recording_id, transcript_id, model, summary, executive_summary, action_items, topics, protocol,
          original_summary, is_locked, created_at, updated_at
      `,
      [
        recordingId,
        recording.transcript.id,
        generated.model,
        generated.summary,
        generated.executiveSummary,
        JSON.stringify(generated.actionItems),
        JSON.stringify(generated.topics),
        JSON.stringify(generated.protocol),
        originalSnapshot,
      ],
    );
    const summary = mapSummary(result.rows[0]);

    await client.query('delete from recording_tasks where recording_id = $1', [recordingId]);

    const contacts = await listContacts(ownerId);
    const tasks = [];
    for (const task of generated.tasks) {
      const inserted = await client.query(
        `
          insert into recording_tasks (recording_id, summary_id, transcript_id, assignee, description, due_text, due_date, assignee_external)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
            assignee_external, status, external_refs, created_at, updated_at
        `,
        [
          recordingId,
          summary.id,
          recording.transcript.id,
          task.assignee || null,
          task.description,
          task.dueText || null,
          task.dueDate || null,
          isAssigneeExternal(task.assignee, contacts),
        ],
      );

      tasks.push(mapTask(inserted.rows[0]));
    }

    return { summary, tasks };
  });

  // UX: после готового протокола подставляем человеческое название по содержанию
  // встречи — но только если текущее выглядит машинным (имя файла, дата-время,
  // uuid). Название, заданное человеком, не трогаем. Сбой — не критичен.
  if (looksAutogeneratedTitle(recording.title)) {
    try {
      await generateRecordingTitle(recordingId, ownerId);
    } catch (error) {
      console.warn(`Auto-title failed for recording ${recordingId}: ${error.message}`);
    }
  }

  return result;
}

export async function updateRecordingMetadata(recordingId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const hasTitle = Object.prototype.hasOwnProperty.call(data, 'title');
  const hasMeetingType = Object.prototype.hasOwnProperty.call(data, 'meetingType');
  // projectIds (array, US-10.1 multi-project) is the current contract;
  // a single projectId is still accepted from pre-epic-10 callers and
  // treated as a one-element (or empty) set.
  const hasProjectIds = Object.prototype.hasOwnProperty.call(data, 'projectIds');
  const hasProjectId = Object.prototype.hasOwnProperty.call(data, 'projectId');
  const hasAsrHints = Object.prototype.hasOwnProperty.call(data, 'asrHints');
  const title = hasTitle && typeof data.title === 'string' ? data.title.trim() : null;
  const meetingType = hasMeetingType && MEETING_TYPES.has(data.meetingType) ? data.meetingType : null;
  // US-2.3: пустая строка = очистить подсказки. Ограничиваем длину, чтобы не
  // раздувать промпт ASR.
  const asrHints = hasAsrHints && typeof data.asrHints === 'string' ? data.asrHints.trim().slice(0, 2000) || null : null;

  let projectIds = null;
  if (hasProjectIds) {
    projectIds = [...new Set((Array.isArray(data.projectIds) ? data.projectIds : []).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
  } else if (hasProjectId) {
    projectIds = typeof data.projectId === 'string' && data.projectId.trim() ? [data.projectId.trim()] : [];
  }

  if (hasTitle && !title) {
    throw new Error('Recording title is required');
  }

  if (hasMeetingType && !meetingType) {
    throw new Error(`meetingType must be one of: ${[...MEETING_TYPES].join(', ')}`);
  }

  const updated = await transaction(async (client) => {
    const result = await client.query(
      `
        update recordings
        set
          title = case when $3 then $4 else recordings.title end,
          auto_named = case when $3 then false else recordings.auto_named end,
          meeting_type = case when $5 then $6 else recordings.meeting_type end,
          asr_hints = case when $7 then $8 else recordings.asr_hints end,
          updated_at = now()
        where recordings.id = $1
          and recordings.owner_id = $2
        returning recordings.id
      `,
      [recordingId, ownerId, hasTitle, title, hasMeetingType, meetingType, hasAsrHints, asrHints],
    );

    if (result.rowCount === 0) {
      return false;
    }

    if (projectIds !== null) {
      // Silently dropping ids the user doesn't own (instead of erroring)
      // matches the old single-project behavior, where a foreign projectId
      // simply didn't pass the ownership guard.
      const owned = projectIds.length
        ? await client.query(`select id from projects where id = any($1::uuid[]) and owner_id = $2`, [
            projectIds,
            ownerId,
          ])
        : { rows: [] };

      await client.query('delete from recording_projects where recording_id = $1', [recordingId]);

      for (const row of owned.rows) {
        await client.query('insert into recording_projects (recording_id, project_id) values ($1, $2) on conflict do nothing', [
          recordingId,
          row.id,
        ]);
      }
    }

    return true;
  });

  return updated ? getRecording(recordingId, ownerId) : null;
}

// original_text/original_segments are populated once at insert time
// (worker.js) and never touched here - they're the immutable AI-produced
// version, kept alongside whatever the user has since edited.
export async function updateTranscript(recordingId, ownerId, input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const hasText = Object.prototype.hasOwnProperty.call(data, 'text');
  const hasSegments = Object.prototype.hasOwnProperty.call(data, 'segments');
  const hasLocked = Object.prototype.hasOwnProperty.call(data, 'locked');

  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const transcriptResult = await query('select id, is_locked from transcripts where recording_id = $1 order by created_at desc limit 1', [
    recordingId,
  ]);
  const transcriptRow = transcriptResult.rows[0];

  if (!transcriptRow) {
    throw new Error('Transcript not found');
  }

  if (transcriptRow.is_locked && (hasText || hasSegments)) {
    throw new Error('Transcript is locked - unlock it before editing');
  }

  const text = hasText ? String(data.text ?? '') : null;
  const segments = hasSegments ? data.segments : null;
  const locked = hasLocked ? Boolean(data.locked) : null;

  const result = await query(
    `
      update transcripts
      set
        text = case when $2 then $3 else transcripts.text end,
        segments = case when $4 then $5::jsonb else transcripts.segments end,
        is_locked = case when $6 then $7 else transcripts.is_locked end,
        updated_at = now()
      where transcripts.id = $1
      returning id, recording_id, job_id, language, text, segments, original_text, original_segments, is_locked, created_at, updated_at
    `,
    [transcriptRow.id, hasText, text, hasSegments, JSON.stringify(segments), hasLocked, locked],
  );

  return mapTranscript(result.rows[0]);
}

// original_summary is populated once per (re)generation (summarizeRecording)
// and never touched here - it's the immutable AI-produced snapshot used to
// compute `isEdited`, kept alongside whatever the user has since edited.
export async function updateRecordingSummary(recordingId, ownerId, input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const hasSummary = Object.prototype.hasOwnProperty.call(data, 'summary');
  const hasExecutiveSummary = Object.prototype.hasOwnProperty.call(data, 'executiveSummary');
  const hasProtocol = Object.prototype.hasOwnProperty.call(data, 'protocol');
  const hasTopics = Object.prototype.hasOwnProperty.call(data, 'topics');
  const hasLocked = Object.prototype.hasOwnProperty.call(data, 'locked');
  const isContentEdit = hasSummary || hasExecutiveSummary || hasProtocol || hasTopics;

  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const summaryResult = await query(
    'select id, is_locked from recording_summaries where recording_id = $1 order by created_at desc limit 1',
    [recordingId],
  );
  const summaryRow = summaryResult.rows[0];

  if (!summaryRow) {
    throw new Error('Protocol not found');
  }

  if (summaryRow.is_locked && isContentEdit) {
    throw new Error('Protocol is locked - unlock it before editing');
  }

  const summary = hasSummary ? String(data.summary ?? '') : null;
  const executiveSummary = hasExecutiveSummary ? String(data.executiveSummary ?? '') : null;
  const protocol = hasProtocol ? normalizeProtocol(data.protocol) : null;
  const topics = hasTopics ? (Array.isArray(data.topics) ? data.topics.map(String) : []) : null;
  const locked = hasLocked ? Boolean(data.locked) : null;

  const result = await query(
    `
      update recording_summaries
      set
        summary = case when $2 then $3 else recording_summaries.summary end,
        executive_summary = case when $4 then $5 else recording_summaries.executive_summary end,
        protocol = case when $6 then $7::jsonb else recording_summaries.protocol end,
        topics = case when $8 then $9::jsonb else recording_summaries.topics end,
        is_locked = case when $10 then $11 else recording_summaries.is_locked end,
        updated_at = now()
      where recording_summaries.id = $1
      returning id, recording_id, transcript_id, model, summary, executive_summary, action_items, topics, protocol,
        original_summary, is_locked, created_at, updated_at
    `,
    [
      summaryRow.id,
      hasSummary,
      summary,
      hasExecutiveSummary,
      executiveSummary,
      hasProtocol,
      JSON.stringify(protocol),
      hasTopics,
      JSON.stringify(topics),
      hasLocked,
      locked,
    ],
  );

  return mapSummary(result.rows[0]);
}

// Relabels every segment spoken by sourceLabel to targetLabel (both are
// diarization labels within the same recording) and drops the now-empty
// recording_speakers row for sourceLabel - this is what "merging two
// wrongly-split speakers into one" (US-7.1) actually means structurally,
// since a segment's speaker is just a string label.
export async function mergeRecordingSpeakers(recordingId, ownerId, sourceLabel, targetLabel) {
  if (!sourceLabel || !targetLabel || sourceLabel === targetLabel) {
    throw new Error('Two different speaker labels are required');
  }

  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const transcriptResult = await query('select id, segments, is_locked from transcripts where recording_id = $1 order by created_at desc limit 1', [
    recordingId,
  ]);
  const transcriptRow = transcriptResult.rows[0];

  if (!transcriptRow) {
    throw new Error('Transcript not found');
  }

  if (transcriptRow.is_locked) {
    throw new Error('Transcript is locked - unlock it before editing');
  }

  const segments = Array.isArray(transcriptRow.segments) ? transcriptRow.segments : [];
  const relabeledSegments = segments.map((segment) =>
    segment.speaker === sourceLabel ? { ...segment, speaker: targetLabel } : segment,
  );
  // Keep the speaker attribution in the flat text (same "speaker\ntext"
  // shape most diarizers emit - see shopotDiarizer/geminiDiarizer/
  // speech2textDiarizer) - joining bare segment texts would silently strip
  // who-said-what from the plain-text view and TXT export.
  const relabeledText = relabeledSegments
    .map((segment) => (segment.speaker ? `${segment.speaker}\n${segment.text}` : segment.text))
    .join('\n\n');

  await transaction(async (client) => {
    await client.query('update transcripts set segments = $1::jsonb, text = $2, updated_at = now() where id = $3', [
      JSON.stringify(relabeledSegments),
      relabeledText,
      transcriptRow.id,
    ]);
    await client.query('delete from recording_speakers where recording_id = $1 and label = $2', [recordingId, sourceLabel]);
  });

  return getRecording(recordingId, ownerId);
}

// UX: распознаёт машинные названия, которые не жалко заменить AI-заголовком —
// имя файла записи (mic-recording-…, audio.mp3), дата-время (20260709_104658),
// uuid, служебные заглушки. Осмысленное человеческое название сюда не попадает.
function looksAutogeneratedTitle(title) {
  const value = String(title || '').trim();

  if (!value) {
    return true;
  }

  return (
    /^mic-recording-/i.test(value) ||
    /^\d{8}[_-]\d{6}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}t/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^(untitled|recording|audio|запись|без названия|test-audio)/i.test(value) ||
    /\.(mp3|wav|m4a|ogg|oga|webm|mp4|mov|mkv|aac|flac)$/i.test(value)
  );
}

export async function generateRecordingTitle(recordingId, ownerId) {
  const recording = await getRecording(recordingId, ownerId);

  if (!recording) {
    return null;
  }

  const title = await generateTitleWithOpenRouter(recording);
  const result = await query(
    `
      update recordings
      set title = $3, auto_named = true, updated_at = now()
      where recordings.id = $1
        and recordings.owner_id = $2
      returning
        recordings.id, recordings.owner_id, recordings.title, recordings.status,
        recordings.source, recordings.duration_seconds, recordings.storage_key, recordings.created_at,
        recordings.updated_at, recordings.original_filename, recordings.mime_type, recordings.file_size_bytes,
        recordings.auto_named, recordings.meeting_type,
        ${RECORDING_PROJECTS_SELECT}
    `,
    [recordingId, ownerId, title],
  );

  return mapRecording(result.rows[0]);
}

export async function createRecordingTask(recordingId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const assignee = typeof data.assignee === 'string' && data.assignee.trim() ? data.assignee.trim() : null;
  const dueText = typeof data.dueText === 'string' && data.dueText.trim() ? data.dueText.trim() : null;

  if (!description) {
    throw new Error('Task description is required');
  }

  const contacts = await listContacts(ownerId);
  const assigneeExternal = isAssigneeExternal(assignee, contacts);

  const result = await query(
    `
      insert into recording_tasks (recording_id, summary_id, transcript_id, assignee, description, due_text, assignee_external, status)
      select
        recording.id,
        (
          select id
          from recording_summaries
          where recording_id = recording.id
          order by created_at desc
          limit 1
        ),
        (
          select id
          from transcripts
          where recording_id = recording.id
          order by created_at desc
          limit 1
        ),
        $3,
        $4,
        $5,
        $6,
        'confirmed'
      from recordings recording
      where recording.id = $1
        and recording.owner_id = $2
      returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
        assignee_external, status, external_refs, created_at, updated_at
    `,
    [recordingId, ownerId, assignee, description, dueText, assigneeExternal],
  );

  return result.rowCount ? mapTask(result.rows[0]) : null;
}

export async function updateRecordingTask(recordingId, taskId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const hasAssignee = Object.prototype.hasOwnProperty.call(data, 'assignee');
  const hasDescription = Object.prototype.hasOwnProperty.call(data, 'description');
  const hasDueText = Object.prototype.hasOwnProperty.call(data, 'dueText');
  const hasStatus = Object.prototype.hasOwnProperty.call(data, 'status');
  let assignee = hasAssignee && typeof data.assignee === 'string' && data.assignee.trim() ? data.assignee.trim() : null;
  const dueText = hasDueText && typeof data.dueText === 'string' && data.dueText.trim() ? data.dueText.trim() : null;
  const description = hasDescription && typeof data.description === 'string' ? data.description.trim() : null;
  const status = hasStatus && typeof data.status === 'string' ? data.status.trim() : null;
  const allowedStatuses = new Set(['extracted', 'confirmed', 'sent', 'done', 'dismissed']);

  if (hasDescription && !description) {
    throw new Error('Task description is required');
  }

  if (hasStatus && !allowedStatuses.has(status)) {
    throw new Error('Unsupported task status');
  }

  const existing = await query(
    `
      select task.assignee
      from recording_tasks task
      join recordings recording on recording.id = task.recording_id
      where task.id = $1 and task.recording_id = $2 and recording.owner_id = $3
    `,
    [taskId, recordingId, ownerId],
  );

  if (existing.rowCount === 0) {
    return null;
  }

  const currentAssignee = hasAssignee ? assignee : existing.rows[0].assignee;
  let hasAssigneeUpdate = hasAssignee;
  let assigneeExternal = null;
  let hasAssigneeExternalUpdate = false;

  // Every confirmed task must end up with an assignee (US-9.2) - fall back
  // to the recording owner rather than leaving it blank or inventing a name.
  if (hasStatus && status === 'confirmed' && !currentAssignee) {
    const owner = await query('select display_name from app_users where id = $1', [ownerId]);
    assignee = owner.rows[0]?.display_name || null;
    hasAssigneeUpdate = true;
    assigneeExternal = false;
    hasAssigneeExternalUpdate = true;
  } else if (hasAssignee) {
    const contacts = await listContacts(ownerId);
    assigneeExternal = isAssigneeExternal(assignee, contacts);
    hasAssigneeExternalUpdate = true;
  }

  const result = await query(
    `
      update recording_tasks task
      set
        assignee = case when $4 then $5 else task.assignee end,
        description = case when $6 then $7 else task.description end,
        due_text = case when $8 then $9 else task.due_text end,
        status = case when $10 then $11 else task.status end,
        assignee_external = case when $12 then $13 else task.assignee_external end,
        updated_at = now()
      from recordings recording
      where task.id = $1
        and task.recording_id = $2
        and recording.id = task.recording_id
        and recording.owner_id = $3
      returning task.id, task.recording_id, task.summary_id, task.transcript_id,
        task.assignee, task.description, task.due_text, task.due_date, task.assignee_external,
        task.status, task.external_refs, task.created_at, task.updated_at
    `,
    [
      taskId,
      recordingId,
      ownerId,
      hasAssigneeUpdate,
      assignee,
      hasDescription,
      description,
      hasDueText,
      dueText,
      hasStatus,
      status,
      hasAssigneeExternalUpdate,
      assigneeExternal,
    ],
  );

  return result.rowCount ? mapTask(result.rows[0]) : null;
}

export async function deleteRecordingTask(recordingId, taskId, ownerId) {
  const result = await query(
    `
      delete from recording_tasks task
      using recordings recording
      where task.id = $1
        and task.recording_id = $2
        and recording.id = task.recording_id
        and recording.owner_id = $3
      returning task.id
    `,
    [taskId, recordingId, ownerId],
  );

  return result.rowCount ? { id: result.rows[0].id } : null;
}

// Reads the existing row first (if any) so a partial PATCH - e.g. an
// accept/reject click that only sends `{suggestionStatus}` - doesn't wipe
// out already-set display/contact fields the way a naive
// always-overwrite-from-input upsert would.
export async function updateRecordingSpeaker(recordingId, label, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};

  if (!String(label || '').trim()) {
    throw new Error('Speaker label is required');
  }

  const existing = await query(
    'select display_name, contact_name, contact_email, suggested_name, suggestion_status from recording_speakers where recording_id = $1 and label = $2',
    [recordingId, label],
  );
  const existingRow = existing.rows[0];

  const hasDisplayName = Object.prototype.hasOwnProperty.call(data, 'displayName');
  const hasContactName = Object.prototype.hasOwnProperty.call(data, 'contactName');
  const hasContactEmail = Object.prototype.hasOwnProperty.call(data, 'contactEmail');
  const hasSuggestionStatus = data.suggestionStatus === 'accepted' || data.suggestionStatus === 'rejected';

  let displayName;

  if (hasDisplayName && typeof data.displayName === 'string' && data.displayName.trim()) {
    displayName = data.displayName.trim();
  } else if (hasSuggestionStatus && data.suggestionStatus === 'accepted' && existingRow?.suggested_name) {
    displayName = existingRow.suggested_name;
  } else {
    displayName = existingRow?.display_name || formatSpeakerLabel(label);
  }

  const contactName = hasContactName
    ? typeof data.contactName === 'string' && data.contactName.trim()
      ? data.contactName.trim()
      : null
    : existingRow?.contact_name || null;
  const contactEmail = hasContactEmail
    ? typeof data.contactEmail === 'string' && data.contactEmail.trim()
      ? data.contactEmail.trim()
      : null
    : existingRow?.contact_email || null;
  const suggestionStatus = hasSuggestionStatus ? data.suggestionStatus : existingRow?.suggestion_status || 'none';

  const result = await query(
    `
      insert into recording_speakers (recording_id, label, display_name, contact_name, contact_email, suggestion_status)
      select recording.id, $2, $4, $5, $6, $7
      from recordings recording
      where recording.id = $1
        and recording.owner_id = $3
      on conflict (recording_id, label)
      do update set
        display_name = excluded.display_name,
        contact_name = excluded.contact_name,
        contact_email = excluded.contact_email,
        suggestion_status = excluded.suggestion_status,
        updated_at = now()
      returning id, recording_id, label, display_name, contact_name, contact_email,
        suggested_name, suggestion_confidence, suggestion_evidence, suggestion_status, created_at, updated_at
    `,
    [recordingId, label, ownerId, displayName, contactName, contactEmail, suggestionStatus],
  );

  return result.rowCount ? mapSpeaker(result.rows[0]) : null;
}

// Metadata-only lookup (no MinIO call) - used to know the total file size
// before deciding whether/how to open a stream, so a Range request never
// has to fetch the whole object just to find out how big it is.
export async function getRecordingAudioMeta(id, ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at,
        original_filename, mime_type, file_size_bytes
      from recordings
      where id = $1 and owner_id = $2
    `,
    [id, ownerId],
  );

  return result.rowCount ? mapRecording(result.rows[0]) : null;
}

export async function getRecordingAudio(id, ownerId, range = null) {
  const recording = await getRecordingAudioMeta(id, ownerId);

  if (!recording) {
    return null;
  }

  if (!recording.storageKey) {
    return { recording, stream: null };
  }

  const stream = range
    ? await getRecordingAudioRange(recording.storageKey, range.offset, range.length)
    : await getRecordingAudioStream(recording.storageKey);

  return {
    recording,
    stream,
    range,
  };
}

/**
 * `retranscribe` заставляет воркер расшифровать запись заново, а не
 * переиспользовать готовую стенограмму. Нужен, когда пользователь сменил метод
 * диаризации или прошлая расшифровка вышла негодной: без него повторная
 * обработка всегда упиралась в контрольную точку в воркере и пересобирала
 * протокол из той же стенограммы.
 */
export async function enqueueRecording(recordingId, ownerId, { retranscribe = false } = {}) {
  // ADR-033: гейт квоты ДО постановки в очередь. Запись уже сохранена
  // (offline-first), поэтому при хард-лимите она не теряется — переводим в
  // 'waiting_quota' и обработку откладываем (гейтится только обработка, не запись).
  const meta = await query(
    'select duration_seconds from recordings where id = $1 and owner_id = $2',
    [recordingId, ownerId],
  );

  if (meta.rowCount === 0) {
    return null;
  }

  const plannedMinutes = minutesFromSeconds(meta.rows[0].duration_seconds);
  const quota = await checkProcessingQuota(ownerId, plannedMinutes);

  if (quota.decision === 'hard') {
    await query(
      "update recordings set status = 'waiting_quota', updated_at = now() where id = $1 and owner_id = $2",
      [recordingId, ownerId],
    );
    track('quota_hard_block', { userId: ownerId, recordingId, props: { reason: quota.reason } });
    track('processing_waiting_quota', { userId: ownerId, recordingId, props: { reason: quota.reason } });
    return { waitingQuota: true, reason: quota.reason };
  }

  if (quota.decision === 'soft') {
    track('quota_soft_warning', { userId: ownerId, recordingId, props: { reason: quota.reason } });
  }

  const job = await transaction(async (client) => {
    const recording = await client.query('select id from recordings where id = $1 and owner_id = $2', [
      recordingId,
      ownerId,
    ]);

    if (recording.rowCount === 0) {
      return null;
    }

    const inserted = await client.query(
      `
        insert into processing_jobs (recording_id, status)
        values ($1, 'queued')
        returning id, recording_id, queue_job_id, status, error, created_at, updated_at
      `,
      [recordingId],
    );

    await client.query(
      `
        update recordings
        set status = 'queued', updated_at = now()
        where id = $1
      `,
      [recordingId],
    );

    return mapJob(inserted.rows[0]);
  });

  if (!job) {
    return null;
  }

  const queueJob = await queue.add(
    'process-recording',
    {
      jobId: job.id,
      recordingId,
      retranscribe,
    },
    {
      attempts: Number(process.env.RECORDING_JOB_ATTEMPTS || 3),
      backoff: {
        type: 'exponential',
        delay: Number(process.env.RECORDING_JOB_BACKOFF_MS || 15000),
      },
    },
  );

  const updated = await query(
    `
      update processing_jobs
      set queue_job_id = $1, updated_at = now()
      where id = $2
      returning id, recording_id, queue_job_id, status, error, created_at, updated_at
    `,
    [queueJob.id, job.id],
  );

  return mapJob(updated.rows[0]);
}

// Cooperative cancellation: if the BullMQ job hasn't been picked up by the
// worker yet, remove it outright and fail immediately. If it's already
// running (mid ASR/LLM call), only set the flag - the worker checks it at
// stage boundaries (see worker.js's checkCancelled) and stops there, rather
// than aborting an in-flight external HTTP call.
export async function cancelRecordingProcessing(recordingId, ownerId) {
  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const jobRow = await query(
    `
      select id, queue_job_id
      from processing_jobs
      where recording_id = $1 and status in ('queued', 'processing')
      order by created_at desc
      limit 1
    `,
    [recordingId],
  );

  if (jobRow.rowCount === 0) {
    return getRecording(recordingId, ownerId);
  }

  const { id: jobId, queue_job_id: queueJobId } = jobRow.rows[0];

  await query('update processing_jobs set cancel_requested = true, updated_at = now() where id = $1', [jobId]);

  let removedBeforeStart = false;

  if (queueJobId) {
    const queueJob = await queue.getJob(queueJobId);

    if (queueJob) {
      const state = await queueJob.getState();

      if (state === 'waiting' || state === 'delayed') {
        await queueJob.remove();
        removedBeforeStart = true;
      }
    }
  }

  if (removedBeforeStart) {
    await transaction(async (client) => {
      await client.query(`update processing_jobs set status = 'failed', error = $2, updated_at = now() where id = $1`, [
        jobId,
        'Отменено пользователем',
      ]);
      await client.query(`update recordings set status = 'failed', updated_at = now() where id = $1`, [recordingId]);
    });
  }

  return getRecording(recordingId, ownerId);
}

export async function attachRecordingAudio(recordingId, file, ownerId) {
  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const probe = await probeUploadedAudio(buffer, file.name);

  const metadata = await saveRecordingAudio(recordingId, file, buffer);
  const result = await query(
    `
      update recordings
      set
        storage_key = $1,
        original_filename = $2,
        mime_type = $3,
        file_size_bytes = $4,
        duration_seconds = $5,
        status = 'uploaded',
        updated_at = now()
      where id = $6
      returning id, owner_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, created_at, updated_at
    `,
    [
      metadata.storageKey,
      metadata.originalFilename,
      metadata.mimeType,
      metadata.fileSizeBytes,
      Math.round(probe.durationSeconds),
      recordingId,
    ],
  );

  return mapRecording(result.rows[0]);
}

/**
 * Потоковый вариант attachRecordingAudio для завершения ЧАНКОВОЙ загрузки (§6.6):
 * файл уже целиком лежит на диске (staging), поэтому пробуем его ffprobe прямо по
 * пути и заливаем в MinIO стримом — без чтения всего файла в память (иначе на 1 ГБ
 * пик ~2×размера в RAM → своп/OOM на маленьком сервере). Buffer-версия выше
 * оставлена для прямого multipart-роута и колбэка бота, где байты уже в памяти.
 */
export async function attachRecordingAudioFromPath(recordingId, filePath, { originalFilename, mimeType, fileSizeBytes }, ownerId) {
  const recording = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const probe = await probeUploadedAudioPath(filePath);
  const metadata = await saveRecordingAudioFromPath(recordingId, filePath, { originalFilename, mimeType, fileSizeBytes });

  const result = await query(
    `
      update recordings
      set
        storage_key = $1,
        original_filename = $2,
        mime_type = $3,
        file_size_bytes = $4,
        duration_seconds = $5,
        status = 'uploaded',
        updated_at = now()
      where id = $6
      returning id, owner_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, created_at, updated_at
    `,
    [
      metadata.storageKey,
      metadata.originalFilename,
      metadata.mimeType,
      metadata.fileSizeBytes,
      Math.round(probe.durationSeconds),
      recordingId,
    ],
  );

  return mapRecording(result.rows[0]);
}

// US-16.4: удаление кладёт запись в корзину (мягко), а не сносит сразу —
// окончательное удаление через неделю (purgeExpiredTrash) или вручную.
export async function deleteRecording(id, ownerId) {
  const result = await query(
    'update recordings set deleted_at = now(), updated_at = now() where id = $1 and owner_id = $2 and deleted_at is null returning id',
    [id, ownerId],
  );

  return result.rowCount ? { id } : null;
}

export async function restoreRecording(id, ownerId) {
  const result = await query(
    'update recordings set deleted_at = null, updated_at = now() where id = $1 and owner_id = $2 and deleted_at is not null returning id',
    [id, ownerId],
  );

  return result.rowCount ? { id } : null;
}

// Окончательное удаление одной записи из корзины (пользователь или ретеншн).
export async function purgeRecording(id, ownerId) {
  const result = await query(
    'delete from recordings where id = $1 and owner_id = $2 and deleted_at is not null returning storage_key',
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const storageKey = result.rows[0].storage_key;

  if (storageKey) {
    await deleteRecordingAudio(storageKey).catch((error) => {
      console.error(`Failed to delete audio object ${storageKey}`, error);
    });
  }

  return { id };
}

const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 7);
const AUDIO_RETENTION_DAYS = Number(process.env.AUDIO_RETENTION_DAYS || 365);

/**
 * US-16.4: окончательное удаление из корзины через неделю + отчёт об удалении.
 * Плюс ретеншн аудио: записи старше года теряют аудиофайл (протокол/задачи
 * остаются — «протоколы/задачи без ограничения; аудио максимум 1 год»).
 * Возвращает отчёт, что именно удалено.
 */
export async function purgeExpiredTrash() {
  const expired = await query(
    `delete from recordings
     where deleted_at is not null and deleted_at < now() - ($1 || ' days')::interval
     returning id, owner_id, title, storage_key`,
    [String(TRASH_RETENTION_DAYS)],
  );

  for (const row of expired.rows) {
    if (row.storage_key) {
      await deleteRecordingAudio(row.storage_key).catch((error) =>
        console.error(`Failed to delete audio ${row.storage_key} on trash purge`, error),
      );
    }
  }

  // Ретеншн аудио: у живых записей старше года убираем только аудио.
  const staleAudio = await query(
    `select id, owner_id, storage_key from recordings
     where deleted_at is null and storage_key is not null
       and created_at < now() - ($1 || ' days')::interval`,
    [String(AUDIO_RETENTION_DAYS)],
  );

  for (const row of staleAudio.rows) {
    await deleteRecordingAudio(row.storage_key).catch((error) =>
      console.error(`Failed to delete aged audio ${row.storage_key}`, error),
    );
    await query('update recordings set storage_key = null, updated_at = now() where id = $1', [row.id]);
  }

  const report = {
    purgedFromTrash: expired.rows.map((row) => ({ id: row.id, ownerId: row.owner_id, title: row.title })),
    audioRetentionCleared: staleAudio.rows.map((row) => ({ id: row.id, ownerId: row.owner_id })),
  };

  if (report.purgedFromTrash.length || report.audioRetentionCleared.length) {
    console.log(
      `Retention: purged ${report.purgedFromTrash.length} from trash, cleared audio on ${report.audioRetentionCleared.length} aged recordings`,
    );
  }

  return report;
}

// US-16.4: метка «конфиденциально» и запрет скачивания.
export async function updateRecordingProtection(id, ownerId, input = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const result = await query(
    `update recordings set
       confidential = case when $3::bool is null then confidential else $3 end,
       download_locked = case when $4::bool is null then download_locked else $4 end,
       updated_at = now()
     where id = $1 and owner_id = $2 and deleted_at is null
     returning id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at,
       original_filename, mime_type, file_size_bytes, auto_named, meeting_url, meeting_bot_task_id,
       recorder_engine, failure_count, meeting_type, confidential, download_locked, deleted_at,
       ${RECORDING_PROJECTS_SELECT}`,
    [id, ownerId, has('confidential') ? Boolean(input.confidential) : null, has('downloadLocked') ? Boolean(input.downloadLocked) : null],
  );

  return result.rowCount ? mapRecording(result.rows[0]) : null;
}

export function registerRecordingRoutes(app) {
  app.get('/api/projects', requireAuth, async (c) => {
    const user = getAuthUser(c);

    return c.json({
      projects: await listProjects(user.id),
    });
  });

  app.post('/api/projects', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const project = await createProject(body, user.id);

      return c.json({ project }, 201);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to create project' }, 400);
    }
  });

  app.patch('/api/projects/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const project = await updateProject(c.req.param('id'), user.id, body);

      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }

      return c.json({ project });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update project' }, 400);
    }
  });

  app.delete('/api/projects/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteProject(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Project not found' }, 404);
    }

    return c.json({ deleted });
  });

  app.get('/api/projects/:id/summary', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const summary = await getProjectSummary(c.req.param('id'), user.id);

    if (!summary) {
      return c.json({ error: 'Project not found' }, 404);
    }

    return c.json(summary);
  });

  app.get('/api/recordings', requireAuth, async (c) => {
    const user = getAuthUser(c);

    return c.json({
      recordings: await listRecordings(user.id, {
        search: c.req.query('search') || '',
        projectId: c.req.query('projectId') || '',
        dateFrom: c.req.query('dateFrom') || '',
        dateTo: c.req.query('dateTo') || '',
        status: c.req.query('status') || '',
        source: c.req.query('source') || '',
        meetingType: c.req.query('meetingType') || '',
        participant: c.req.query('participant') || '',
        hasTasks: c.req.query('hasTasks') || '',
        trash: c.req.query('trash') || '',
      }),
    });
  });

  app.get('/api/tasks/search', requireAuth, async (c) => {
    const user = getAuthUser(c);

    return c.json({
      tasks: await searchTasks(user.id, {
        search: c.req.query('search') || '',
        status: c.req.query('status') || '',
        projectId: c.req.query('projectId') || '',
        dueFrom: c.req.query('dueFrom') || '',
        dueTo: c.req.query('dueTo') || '',
      }),
    });
  });

  app.post('/api/recordings', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await createRecording(body, user.id);

    return c.json({ recording }, 201);
  });

  app.post('/api/recordings/meeting-bot', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const recording = isSelfHostedMeetingUrl(body.meetingUrl)
        ? await createSelfHostedMeetingRecording(body, user.id)
        : await createMeetingBotRecording(body, user.id);

      return c.json({ recording }, 201);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to send the bot to the meeting' }, 400);
    }
  });

  app.post('/api/recordings/:id/meeting-bot/stop', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const recording =
        (await stopSelfHostedMeetingRecording(c.req.param('id'), user.id)) ||
        (await stopMeetingBotRecording(c.req.param('id'), user.id));

      if (!recording) {
        return c.json({ error: 'Recording not found or has no active bot' }, 404);
      }

      return c.json({ recording });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to stop the meeting bot' }, 400);
    }
  });

  app.post('/api/internal/recorder-bot/callback', async (c) => {
    const secret = c.req.header('X-Internal-Secret') || '';

    if (!process.env.RECORDER_BOT_INTERNAL_SECRET || !constantTimeEqual(secret, process.env.RECORDER_BOT_INTERNAL_SECRET)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const formData = await c.req.raw.formData().catch(() => null);
    const recordingId = formData?.get('recordingId');
    const errorMessage = formData?.get('error') || null;
    const file = formData?.get('file');

    if (!recordingId) {
      return c.json({ error: 'recordingId is required' }, 400);
    }

    const recording = await completeSelfHostedMeetingRecording(
      recordingId,
      file && typeof file.arrayBuffer === 'function' ? file : null,
      errorMessage,
    );

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording });
  });

  app.get('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording });
  });

  app.get('/api/recordings/:id/audio', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const meta = await getRecordingAudioMeta(c.req.param('id'), user.id);

    if (!meta) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    if (!meta.storageKey) {
      return c.json({ error: 'Recording audio not found' }, 404);
    }

    const totalSize = meta.fileSizeBytes;
    const range = parseRangeHeader(c.req.header('Range'), totalSize);
    const audio = await getRecordingAudio(c.req.param('id'), user.id, range);

    if (!audio?.stream) {
      return c.json({ error: 'Recording audio not found' }, 404);
    }

    const filename = audio.recording.originalFilename || 'recording-audio';
    const headers = {
      'Content-Type': audio.recording.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Accept-Ranges': 'bytes',
    };

    if (range) {
      headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`;
      headers['Content-Length'] = String(range.length);
      return c.body(Readable.toWeb(audio.stream), 206, headers);
    }

    if (totalSize) {
      headers['Content-Length'] = String(totalSize);
    }

    return c.body(Readable.toWeb(audio.stream), 200, headers);
  });

  app.patch('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const recording = await updateRecordingMetadata(c.req.param('id'), user.id, body);

      if (!recording) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ recording });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update recording' }, 400);
    }
  });

  app.patch('/api/recordings/:id/transcript', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const transcript = await updateTranscript(c.req.param('id'), user.id, body);

      if (!transcript) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ transcript });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update transcript' }, 400);
    }
  });

  app.post('/api/recordings/:id/title-suggestion', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const recording = await generateRecordingTitle(c.req.param('id'), user.id);

      if (!recording) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ recording });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to generate recording title' }, 400);
    }
  });

  app.post(
    '/api/recordings/:id/audio',
    requireAuth,
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'File too large' }, 413),
    }),
    async (c) => {
      const user = getAuthUser(c);
      const formData = await c.req.raw.formData().catch(() => null);
      const file = formData?.get('file');

      if (!file || typeof file.arrayBuffer !== 'function') {
        return c.json({ error: 'Expected multipart form-data with file field named "file"' }, 400);
      }

      try {
        const recording = await attachRecordingAudio(c.req.param('id'), file, user.id);

        if (!recording) {
          return c.json({ error: 'Recording not found' }, 404);
        }

        // Same auto-enqueue as the chunked-upload completion path
        // (uploadSessions.js) - the pipeline runs end-to-end without a
        // manual "Запустить обработку" click regardless of which upload
        // route was used.
        await enqueueRecording(c.req.param('id'), user.id);

        return c.json({ recording });
      } catch (error) {
        if (error instanceof UploadValidationError) {
          return c.json({ error: error.message, code: error.code }, 400);
        }

        throw error;
      }
    },
  );

  app.post('/api/recordings/:id/jobs', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const job = await enqueueRecording(c.req.param('id'), user.id, { retranscribe: body.retranscribe === true });

    if (!job) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    // ADR-033: обработка заблокирована квотой — запись сохранена, ждёт квоты.
    if (job.waitingQuota) {
      return c.json({ waitingQuota: true, reason: job.reason, status: 'waiting_quota' }, 202);
    }

    return c.json({ job }, 202);
  });

  app.post('/api/recordings/:id/jobs/cancel', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await cancelRecordingProcessing(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording });
  });

  app.post('/api/recordings/:id/summary', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await summarizeRecording(c.req.param('id'), user.id, {
        length: body.length,
        instruction: body.instruction,
        timezoneOffsetMinutes: body.timezoneOffsetMinutes,
      });

      if (!result) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to summarize recording' }, 400);
    }
  });

  app.patch('/api/recordings/:id/summary', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const summary = await updateRecordingSummary(c.req.param('id'), user.id, body);

      if (!summary) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ summary });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update protocol' }, 400);
    }
  });

  // Not scoped to a recording - a lightweight ASR-only helper for
  // dictating into a text field (protocol edit, regenerate instruction)
  // instead of typing. Plain transcription via the same OpenRouter path
  // worker.js uses as its ASR fallback, no diarization/pipeline/recording
  // row involved.
  app.post(
    '/api/voice-note-transcript',
    requireAuth,
    bodyLimit({
      maxSize: 25 * 1024 * 1024,
      onError: (c) => c.json({ error: 'Voice note too large' }, 413),
    }),
    async (c) => {
      const formData = await c.req.raw.formData().catch(() => null);
      const file = formData?.get('file');

      if (!file || typeof file.arrayBuffer !== 'function') {
        return c.json({ error: 'Expected multipart form-data with file field named "file"' }, 400);
      }

      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await transcribeWithOpenRouter(file, buffer, {});

        return c.json({ text: result?.text || '' });
      } catch (error) {
        return c.json({ error: error.message || 'Failed to transcribe voice note' }, 400);
      }
    },
  );

  app.post('/api/recordings/:id/email', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const smtpConfig = await getUserSmtpConfig(user.id);
      const delivery = await sendRecordingEmail(recording, body, smtpConfig);

      return c.json({ delivery });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to send recording email' }, 400);
    }
  });

  app.post('/api/recordings/:id/telegram', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const telegramConfig = await getUserTelegramConfig(user.id);
      const delivery = await sendRecordingTelegram(recording, body, telegramConfig || {});

      return c.json({ delivery });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to send recording to Telegram' }, 400);
    }
  });

  app.post('/api/recordings/:recordingId/bitrix', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recordingId = c.req.param('recordingId');
    const recording = await getRecording(recordingId, user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const requestedIds = Array.isArray(body.taskIds) ? new Set(body.taskIds) : null;
    const candidateTasks = (recording.tasks || []).filter((task) => {
      if (requestedIds) {
        return requestedIds.has(task.id);
      }

      return !task.externalRefs?.bitrix24;
    });

    if (!candidateTasks.length) {
      return c.json({ error: 'No tasks to send' }, 400);
    }

    try {
      const bitrixConfig = await getUserBitrixConfig(user.id);
      const results = await sendTasksToBitrix(recording, candidateTasks, bitrixConfig || {});

      await transaction(async (client) => {
        for (const result of results) {
          if (!result.ok) {
            continue;
          }

          await client.query(
            `
              update recording_tasks
              set
                status = 'sent',
                external_refs = external_refs || jsonb_build_object('bitrix24', jsonb_build_object('taskId', $2::text, 'sentAt', now())),
                updated_at = now()
              where id = $1
            `,
            [result.taskId, String(result.bitrixTaskId)],
          );
        }
      });

      return c.json({ results });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to send tasks to Bitrix24' }, 400);
    }
  });

  // Справочники Б24 для формы отправки (US-11.4): сотрудники и группы проекта.
  app.get('/api/bitrix/employees', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const users = await fetchBitrixUsers((await getUserBitrixConfig(user.id)) || {});
      return c.json({
        employees: users.map((item) => ({
          id: String(item.id),
          name: [item.lastName, item.firstName, item.secondName].filter(Boolean).join(' '),
          email: item.email,
        })),
      });
    } catch (error) {
      return c.json({ error: error.message || 'Не удалось получить сотрудников Битрикс24' }, 400);
    }
  });

  app.get('/api/bitrix/groups', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      return c.json({ groups: await fetchBitrixGroups((await getUserBitrixConfig(user.id)) || {}) });
    } catch (error) {
      return c.json({ error: error.message || 'Не удалось получить группы Битрикс24' }, 400);
    }
  });

  app.get('/api/recordings/:recordingId/bitrix-task-matches', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('recordingId'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const matches = await matchRecordingTasksToBitrix(recording.tasks || [], (await getUserBitrixConfig(user.id)) || {});
      return c.json({ matches });
    } catch (error) {
      return c.json({ error: error.message || 'Не удалось сопоставить исполнителей с Битрикс24' }, 400);
    }
  });

  /**
   * US-11.4: отправка одной задачи с явным сотрудником и группой. Дубли — по
   * точному названию в Б24: без confirmDuplicate отправка останавливается и
   * решает пользователь. После отправки источник истины — Б24: задача в
   * Stenogram не меняется (кроме отметки «отправлена» и ссылки), обратной
   * синхронизации нет.
   */
  app.post('/api/recordings/:recordingId/tasks/:taskId/send-bitrix', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recordingId = c.req.param('recordingId');
    const taskId = c.req.param('taskId');
    const recording = await getRecording(recordingId, user.id);
    const task = recording?.tasks?.find((item) => item.id === taskId);

    if (!recording || !task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    if (!String(body.responsibleId || '').trim()) {
      // Спека: «если не найден — сообщение, задачу не отправляем».
      track('incomplete_task_blocked_b24', { userId: user.id, recordingId });
      return c.json({ error: 'Сотрудник Битрикс24 не выбран — задача не отправлена' }, 400);
    }

    const bitrixConfig = (await getUserBitrixConfig(user.id)) || {};

    try {
      if (!body.confirmDuplicate) {
        const duplicates = await findBitrixTaskDuplicates(bitrixConfig, task.description);

        if (duplicates.length) {
          return c.json(
            {
              error: 'В Битрикс24 уже есть задача с таким названием',
              duplicates,
            },
            409,
          );
        }
      }

      const { result, attempts } = await sendWithRetry(() =>
        sendTaskToBitrix(bitrixConfig, recording, task, {
          responsibleId: String(body.responsibleId).trim(),
          groupId: String(body.groupId || '').trim() || null,
        }),
      );

      await recordDelivery({
        ownerId: user.id,
        recordingId,
        channel: 'bitrix',
        payloadKind: 'tasks',
        recipients: [result.responsibleId],
        status: 'sent',
        attempts,
        externalRefs: result,
      });

      const updated = await query(
        `
          update recording_tasks
          set
            status = case when status in ('extracted', 'confirmed') then 'sent' else status end,
            external_refs = external_refs || jsonb_build_object('bitrix24', jsonb_build_object(
              'taskId', $2::text, 'url', $3::text, 'responsibleId', $4::text, 'groupId', $5::text, 'sentAt', now())),
            updated_at = now()
          where id = $1
          returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
            assignee_external, status, external_refs, created_at, updated_at
        `,
        [taskId, String(result.bitrixTaskId), result.url, result.responsibleId, result.groupId],
      );

      track('task_sent_bitrix', { userId: user.id, recordingId });
      track('delivery_sent', { userId: user.id, recordingId, props: { channel: 'bitrix', payloadKind: 'tasks' } });

      return c.json({ result, task: mapTask(updated.rows[0]) });
    } catch (error) {
      await recordDelivery({
        ownerId: user.id,
        recordingId,
        channel: 'bitrix',
        payloadKind: 'tasks',
        recipients: [String(body.responsibleId || '')].filter(Boolean),
        status: 'failed',
        attempts: error.attempts || 1,
        lastError: error.message,
      });

      track('delivery_failed', { userId: user.id, recordingId, props: { channel: 'bitrix', payloadKind: 'tasks' } });

      return c.json({ error: error.message || 'Не удалось отправить задачу в Битрикс24' }, 400);
    }
  });

  app.get('/api/recordings/:recordingId/bitrix-speaker-matches', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('recordingId'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const bitrixConfig = await getUserBitrixConfig(user.id);
      const matches = await matchRecordingSpeakersToBitrix(recording.speakers || [], bitrixConfig || {});

      return c.json({ matches });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to match speakers against Bitrix24' }, 400);
    }
  });

  app.get('/api/recordings/:recordingId/contact-speaker-matches', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('recordingId'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const matches = await matchRecordingSpeakersToContacts(c.req.param('recordingId'), user.id, recording.speakers || []);
      return c.json({ matches });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to match speakers against contacts' }, 400);
    }
  });

  app.get('/api/recordings/:recordingId/task-assignee-matches', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('recordingId'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    try {
      const matches = await matchRecordingTasksToContacts(user.id, recording.tasks || []);
      return c.json({ matches });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to match task assignees against contacts' }, 400);
    }
  });

  app.post('/api/recordings/:recordingId/tasks', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const task = await createRecordingTask(c.req.param('recordingId'), user.id, body);

      if (!task) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ task }, 201);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to create task' }, 400);
    }
  });

  app.patch('/api/recordings/:recordingId/tasks/:taskId', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const task = await updateRecordingTask(c.req.param('recordingId'), c.req.param('taskId'), user.id, body);

      if (!task) {
        return c.json({ error: 'Task not found' }, 404);
      }

      // NFR §6: пользователь подтвердил неполную задачу (без срока/исполнителя).
      if (body.status === 'confirmed' && isTaskIncomplete(task)) {
        track('incomplete_task_confirmed', { userId: user.id, recordingId: c.req.param('recordingId') });
      }

      return c.json({ task });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update task' }, 400);
    }
  });

  app.delete('/api/recordings/:recordingId/tasks/:taskId', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteRecordingTask(c.req.param('recordingId'), c.req.param('taskId'), user.id);

    if (!deleted) {
      return c.json({ error: 'Task not found' }, 404);
    }

    return c.json({ task: deleted });
  });

  app.post('/api/recordings/:recordingId/tasks/:taskId/send-email', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recordingId = c.req.param('recordingId');
    const taskId = c.req.param('taskId');
    const recording = await getRecording(recordingId, user.id);
    const task = recording?.tasks?.find((item) => item.id === taskId);

    if (!recording || !task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    try {
      const smtpConfig = await getUserSmtpConfig(user.id);
      const delivery = await sendTaskEmail(smtpConfig, body.email, recording, task);

      const updated = await query(
        `
          update recording_tasks
          set
            status = case when status in ('extracted', 'confirmed') then 'sent' else status end,
            external_refs = external_refs || jsonb_build_object('email', jsonb_build_object('to', $2::text, 'sentAt', now())),
            updated_at = now()
          where id = $1
          returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
            assignee_external, status, external_refs, created_at, updated_at
        `,
        [taskId, body.email],
      );

      track('delivery_sent', { userId: user.id, recordingId, props: { channel: 'email', payloadKind: 'tasks' } });
      if (isTaskIncomplete(task)) {
        track('incomplete_task_sent_email', { userId: user.id, recordingId });
      }

      return c.json({ delivery, task: mapTask(updated.rows[0]) });
    } catch (error) {
      track('delivery_failed', { userId: user.id, recordingId, props: { channel: 'email', payloadKind: 'tasks' } });
      return c.json({ error: error.message || 'Failed to send task email' }, 400);
    }
  });

  /**
   * US-11.3: задача уходит в личный чат исполнителю. chatId приходит из
   * контакта с привязанным Telegram (UI подставляет его из сопоставления
   * исполнителя); отправка идёт через автоповторы US-11.1 и пишется в журнал
   * доставки, статус нажатий кнопок обновляет поллер в worker.js.
   */
  app.post('/api/recordings/:recordingId/tasks/:taskId/send-telegram', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recordingId = c.req.param('recordingId');
    const taskId = c.req.param('taskId');
    const recording = await getRecording(recordingId, user.id);
    const task = recording?.tasks?.find((item) => item.id === taskId);

    if (!recording || !task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const telegramConfig = (await getUserTelegramConfig(user.id)) || {};

    try {
      const { result, attempts } = await sendWithRetry(() => sendTaskTelegram(telegramConfig, body.chatId, recording, task));

      await recordDelivery({
        ownerId: user.id,
        recordingId,
        channel: 'telegram',
        payloadKind: 'tasks',
        recipients: [result.chatId],
        status: 'sent',
        attempts,
        externalRefs: result,
      });

      const updated = await query(
        `
          update recording_tasks
          set
            status = case when status in ('extracted', 'confirmed') then 'sent' else status end,
            external_refs = external_refs || jsonb_build_object('telegram', jsonb_build_object(
              'chatId', $2::text, 'messageId', $3::bigint, 'sentAt', now())),
            updated_at = now()
          where id = $1
          returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, due_date,
            assignee_external, status, external_refs, created_at, updated_at
        `,
        [taskId, result.chatId, result.messageId],
      );

      track('delivery_sent', { userId: user.id, recordingId, props: { channel: 'telegram', payloadKind: 'tasks' } });
      if (isTaskIncomplete(task)) {
        track('incomplete_task_sent_telegram', { userId: user.id, recordingId });
      }

      return c.json({ delivery: result, task: mapTask(updated.rows[0]) });
    } catch (error) {
      await recordDelivery({
        ownerId: user.id,
        recordingId,
        channel: 'telegram',
        payloadKind: 'tasks',
        recipients: [String(body.chatId || '')].filter(Boolean),
        status: 'failed',
        attempts: error.attempts || 1,
        lastError: error.message,
      });

      track('delivery_failed', { userId: user.id, recordingId, props: { channel: 'telegram', payloadKind: 'tasks' } });

      return c.json({ error: error.message || 'Не удалось отправить задачу в Telegram' }, 400);
    }
  });

  app.patch('/api/recordings/:recordingId/speakers/:label', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const speaker = await updateRecordingSpeaker(c.req.param('recordingId'), c.req.param('label'), user.id, body);

      if (!speaker) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ speaker });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to update speaker' }, 400);
    }
  });

  app.post('/api/recordings/:id/speakers/merge', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    try {
      const recording = await mergeRecordingSpeakers(c.req.param('id'), user.id, body.sourceLabel, body.targetLabel);

      if (!recording) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ recording });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to merge speakers' }, 400);
    }
  });

  // US-16.4: метка «конфиденциально» и запрет скачивания.
  app.patch('/api/recordings/:id/protection', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await updateRecordingProtection(c.req.param('id'), user.id, body);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording });
  });

  // US-16.4: удаление кладёт в корзину (мягко), не сносит сразу.
  app.delete('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteRecording(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording: deleted });
  });

  app.post('/api/recordings/:id/restore', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const restored = await restoreRecording(c.req.param('id'), user.id);

    if (!restored) {
      return c.json({ error: 'Запись не найдена в корзине' }, 404);
    }

    return c.json({ recording: restored });
  });

  // Окончательное удаление из корзины (минуя недельный срок).
  app.delete('/api/recordings/:id/purge', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const purged = await purgeRecording(c.req.param('id'), user.id);

    if (!purged) {
      return c.json({ error: 'Запись не найдена в корзине' }, 404);
    }

    return c.json({ recording: purged });
  });
}
