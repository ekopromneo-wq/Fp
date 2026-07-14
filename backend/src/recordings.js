import { bodyLimit } from 'hono/body-limit';
import { createRecordingQueue } from './queue.js';
import {
  getAuthUser,
  getUserBitrixConfig,
  getUserDiarizationConfig,
  getUserSmtpConfig,
  getUserTelegramConfig,
  requireAuth,
} from './auth.js';
import { query, transaction } from './db.js';
import { sendRecordingEmail, sendTaskEmail } from './email.js';
import { sendRecordingTelegram } from './telegram.js';
import { sendTasksToBitrix, matchRecordingSpeakersToBitrix } from './bitrix.js';
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
import { deleteRecordingAudio, getRecordingAudioRange, getRecordingAudioStream, saveRecordingAudio } from './storage.js';
import { MAX_UPLOAD_BYTES, UploadValidationError, probeUploadedAudio } from './uploadValidation.js';
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
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    project: row.project_id
      ? {
          id: row.project_id,
          name: row.project_name,
          color: row.project_color,
        }
      : null,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'VoxMate',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `Ты помощник VoxMate. Верни строго JSON без markdown. Поля: summary:string (полная версия), executiveSummary:string (краткая выжимка сути встречи, 3-5 строк), topics:string[], protocol:{${template.sections.join(',')}}, tasks:{assignee:string|null,description:string,dueText:string|null}[]. ` +
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
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'VoxMate',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник VoxMate. Верни строго JSON без markdown с полем title:string. Название должно быть по-русски, короткое, 4-9 слов, без кавычек, без даты если дата не дана явно.',
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

export async function listProjects(ownerId) {
  const result = await query(
    `
      select id, owner_id, name, color, created_at, updated_at
      from projects
      where owner_id = $1 or owner_id is null
      order by name asc
    `,
    [ownerId],
  );

  return result.rows.map(mapProject);
}

export async function createProject(input, ownerId) {
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '';
  const color = typeof input.color === 'string' && input.color.trim() ? input.color.trim() : '#235b4f';

  if (!name) {
    throw new Error('Project name is required');
  }

  const result = await query(
    `
      insert into projects (owner_id, name, color)
      values ($1, $2, $3)
      returning id, owner_id, name, color, created_at, updated_at
    `,
    [ownerId, name, color],
  );

  return mapProject(result.rows[0]);
}

export async function listRecordings(ownerId, filters = {}) {
  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  const projectId = typeof filters.projectId === 'string' && filters.projectId.trim() ? filters.projectId.trim() : null;
  const result = await query(
    `
      select
        recordings.id, recordings.owner_id, recordings.project_id, recordings.title, recordings.status,
        recordings.source, recordings.duration_seconds, recordings.storage_key, recordings.created_at,
        recordings.updated_at, recordings.original_filename, recordings.mime_type, recordings.file_size_bytes,
        recordings.auto_named, recordings.meeting_url, recordings.meeting_bot_task_id, recordings.failure_count,
        recordings.meeting_type,
        projects.name as project_name, projects.color as project_color
      from recordings
      left join projects on projects.id = recordings.project_id
      where (recordings.owner_id = $1 or recordings.owner_id is null)
        and ($2 = '' or recordings.title ilike '%' || $2 || '%'
          or recordings.original_filename ilike '%' || $2 || '%'
          or projects.name ilike '%' || $2 || '%'
          or exists (
            select 1
            from transcripts
            where transcripts.recording_id = recordings.id
              and transcripts.text ilike '%' || $2 || '%'
          ))
        and ($3::uuid is null or recordings.project_id = $3::uuid)
      order by recordings.created_at desc
      limit 50
    `,
    [ownerId, search, projectId],
  );

  return result.rows.map(mapRecording);
}

export async function createRecording(input, ownerId) {
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled recording';
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'manual';
  const meetingType = MEETING_TYPES.has(input.meetingType) ? input.meetingType : 'meeting';

  const result = await query(
    `
      insert into recordings (owner_id, title, source, duration_seconds, storage_key, meeting_type)
      values ($1, $2, $3, $4, $5, $6)
      returning id, owner_id, project_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, auto_named, meeting_type, created_at, updated_at,
        null as project_name, null as project_color
    `,
    [ownerId, title, source, input.durationSeconds || null, input.storageKey || null, meetingType],
  );

  return mapRecording(result.rows[0]);
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
    'select meeting_bot_task_id from recordings where id = $1 and (owner_id = $2 or owner_id is null)',
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
    'select meeting_bot_task_id from recordings where id = $1 and (owner_id = $2 or owner_id is null) and recorder_engine = $3',
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
      , original_filename, mime_type, file_size_bytes, auto_named, project_id, meeting_url, meeting_bot_task_id,
        recorder_engine, failure_count, meeting_type,
        (select name from projects where projects.id = recordings.project_id) as project_name,
        (select color from projects where projects.id = recordings.project_id) as project_color
      from recordings
      where id = $1 and (owner_id = $2 or owner_id is null)
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

  return transaction(async (client) => {
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
}

export async function updateRecordingMetadata(recordingId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const hasTitle = Object.prototype.hasOwnProperty.call(data, 'title');
  const hasProjectId = Object.prototype.hasOwnProperty.call(data, 'projectId');
  const hasMeetingType = Object.prototype.hasOwnProperty.call(data, 'meetingType');
  const title = hasTitle && typeof data.title === 'string' ? data.title.trim() : null;
  const projectId = hasProjectId && typeof data.projectId === 'string' && data.projectId.trim() ? data.projectId.trim() : null;
  const meetingType = hasMeetingType && MEETING_TYPES.has(data.meetingType) ? data.meetingType : null;

  if (hasTitle && !title) {
    throw new Error('Recording title is required');
  }

  if (hasMeetingType && !meetingType) {
    throw new Error(`meetingType must be one of: ${[...MEETING_TYPES].join(', ')}`);
  }

  const result = await query(
    `
      update recordings
      set
        title = case when $3 then $4 else recordings.title end,
        project_id = case when $5 then $6::uuid else recordings.project_id end,
        auto_named = case when $3 then false else recordings.auto_named end,
        meeting_type = case when $7 then $8 else recordings.meeting_type end,
        updated_at = now()
      where recordings.id = $1
        and (recordings.owner_id = $2 or recordings.owner_id is null)
        and (
          not $5
          or $6::uuid is null
          or exists (
            select 1
            from projects
            where projects.id = $6::uuid
              and (projects.owner_id = $2 or projects.owner_id is null)
          )
        )
      returning
        recordings.id, recordings.owner_id, recordings.project_id, recordings.title, recordings.status,
        recordings.source, recordings.duration_seconds, recordings.storage_key, recordings.created_at,
        recordings.updated_at, recordings.original_filename, recordings.mime_type, recordings.file_size_bytes,
        recordings.auto_named, recordings.meeting_type,
        (select name from projects where projects.id = recordings.project_id) as project_name,
        (select color from projects where projects.id = recordings.project_id) as project_color
    `,
    [recordingId, ownerId, hasTitle, title, hasProjectId, projectId, hasMeetingType, meetingType],
  );

  return result.rowCount ? mapRecording(result.rows[0]) : null;
}

// original_text/original_segments are populated once at insert time
// (worker.js) and never touched here - they're the immutable AI-produced
// version, kept alongside whatever the user has since edited.
export async function updateTranscript(recordingId, ownerId, input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const hasText = Object.prototype.hasOwnProperty.call(data, 'text');
  const hasSegments = Object.prototype.hasOwnProperty.call(data, 'segments');
  const hasLocked = Object.prototype.hasOwnProperty.call(data, 'locked');

  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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

  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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

  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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
        and (recordings.owner_id = $2 or recordings.owner_id is null)
      returning
        recordings.id, recordings.owner_id, recordings.project_id, recordings.title, recordings.status,
        recordings.source, recordings.duration_seconds, recordings.storage_key, recordings.created_at,
        recordings.updated_at, recordings.original_filename, recordings.mime_type, recordings.file_size_bytes,
        recordings.auto_named, recordings.meeting_type,
        (select name from projects where projects.id = recordings.project_id) as project_name,
        (select color from projects where projects.id = recordings.project_id) as project_color
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
        and (recording.owner_id = $2 or recording.owner_id is null)
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
      where task.id = $1 and task.recording_id = $2 and (recording.owner_id = $3 or recording.owner_id is null)
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
        and (recording.owner_id = $3 or recording.owner_id is null)
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
        and (recording.owner_id = $3 or recording.owner_id is null)
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
        and (recording.owner_id = $3 or recording.owner_id is null)
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
      where id = $1 and (owner_id = $2 or owner_id is null)
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

export async function enqueueRecording(recordingId, ownerId) {
  const job = await transaction(async (client) => {
    const recording = await client.query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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
  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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
  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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

export async function deleteRecording(id, ownerId) {
  const result = await query('delete from recordings where id = $1 and (owner_id = $2 or owner_id is null) returning storage_key', [
    id,
    ownerId,
  ]);

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

  app.get('/api/recordings', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const search = c.req.query('search') || '';
    const projectId = c.req.query('projectId') || '';

    return c.json({
      recordings: await listRecordings(user.id, { search, projectId }),
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

    if (!process.env.RECORDER_BOT_INTERNAL_SECRET || secret !== process.env.RECORDER_BOT_INTERNAL_SECRET) {
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
    const job = await enqueueRecording(c.req.param('id'), user.id);

    if (!job) {
      return c.json({ error: 'Recording not found' }, 404);
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

      return c.json({ delivery, task: mapTask(updated.rows[0]) });
    } catch (error) {
      return c.json({ error: error.message || 'Failed to send task email' }, 400);
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

  app.delete('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteRecording(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording: deleted });
  });
}
