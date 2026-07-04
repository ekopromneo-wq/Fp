import { createRecordingQueue } from './queue.js';
import { getAuthUser, requireAuth } from './auth.js';
import { query, transaction } from './db.js';
import { Readable } from 'node:stream';
import { deleteRecordingAudio, getRecordingAudioStream, saveRecordingAudio } from './storage.js';

const queue = createRecordingQueue();

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
    durationSeconds: row.duration_seconds,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    autoNamed: Boolean(row.auto_named),
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapSummary(row) {
  return row
    ? {
        id: row.id,
        recordingId: row.recording_id,
        transcriptId: row.transcript_id,
        model: row.model,
        summary: row.summary,
        actionItems: row.action_items,
        topics: row.topics,
        protocol: row.protocol || { agenda: [], decisions: [], risks: [] },
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
    status: row.status,
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
        createdAt: null,
        updatedAt: null,
      });
    }
  }

  return [...storedByLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeProtocol(input) {
  const protocol = input && typeof input === 'object' ? input : {};

  return {
    agenda: Array.isArray(protocol.agenda) ? protocol.agenda.map(String).filter(Boolean) : [],
    decisions: Array.isArray(protocol.decisions) ? protocol.decisions.map(String).filter(Boolean) : [],
    risks: Array.isArray(protocol.risks) ? protocol.risks.map(String).filter(Boolean) : [],
  };
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

async function generateSummaryWithOpenRouter(transcriptText) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const model = process.env.OPENROUTER_LLM_MODEL || 'openai/gpt-4o-mini';
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
            'Ты помощник VoxMate. Верни строго JSON без markdown. Поля: summary:string, topics:string[], protocol:{agenda:string[],decisions:string[],risks:string[]}, tasks:{assignee:string|null,description:string,dueText:string|null}[]. Пиши по-русски, кратко и конкретно. Если исполнитель или срок не названы явно, ставь null.',
        },
        {
          role: 'user',
          content: `Сделай структурированный протокол стенограммы и извлеки задачи в формате кто-что-когда.\n\nСтенограмма:\n${transcriptText}`,
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
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : parsed.actionItems || []).map(normalizeTask).filter(Boolean);

  return {
    model,
    summary: String(parsed.summary || '').trim(),
    actionItems: tasks.map((task) => task.description),
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
    protocol: normalizeProtocol(parsed.protocol),
    tasks,
  };
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
        recordings.auto_named, projects.name as project_name, projects.color as project_color
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

  const result = await query(
    `
      insert into recordings (owner_id, title, source, duration_seconds, storage_key)
      values ($1, $2, $3, $4, $5)
      returning id, owner_id, project_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, auto_named, created_at, updated_at,
        null as project_name, null as project_color
    `,
    [ownerId, title, source, input.durationSeconds || null, input.storageKey || null],
  );

  return mapRecording(result.rows[0]);
}

export async function getRecording(id, ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at
      , original_filename, mime_type, file_size_bytes, auto_named, project_id,
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
        select id, recording_id, queue_job_id, status, error, created_at, updated_at
        from processing_jobs
        where recording_id = $1
        order by created_at desc
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, job_id, language, text, segments, created_at, updated_at
        from transcripts
        where recording_id = $1
        order by created_at desc
        limit 1
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, transcript_id, model, summary, action_items, topics, protocol, created_at, updated_at
        from recording_summaries
        where recording_id = $1
        order by created_at desc
        limit 1
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, summary_id, transcript_id, assignee, description, due_text, status, created_at, updated_at
        from recording_tasks
        where recording_id = $1 and status <> 'dismissed'
        order by created_at asc
      `,
      [id],
    ),
    query(
      `
        select id, recording_id, label, display_name, contact_name, contact_email, created_at, updated_at
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

export async function summarizeRecording(recordingId, ownerId) {
  const recording = await getRecording(recordingId, ownerId);

  if (!recording) {
    return null;
  }

  if (!recording.transcript?.text) {
    throw new Error('Recording has no transcript yet');
  }

  const generated = await generateSummaryWithOpenRouter(recording.transcript.text);

  return transaction(async (client) => {
    const result = await client.query(
      `
        insert into recording_summaries (recording_id, transcript_id, model, summary, action_items, topics, protocol)
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
        returning id, recording_id, transcript_id, model, summary, action_items, topics, protocol, created_at, updated_at
      `,
      [
        recordingId,
        recording.transcript.id,
        generated.model,
        generated.summary,
        JSON.stringify(generated.actionItems),
        JSON.stringify(generated.topics),
        JSON.stringify(generated.protocol),
      ],
    );
    const summary = mapSummary(result.rows[0]);

    await client.query('delete from recording_tasks where recording_id = $1', [recordingId]);

    const tasks = [];
    for (const task of generated.tasks) {
      const inserted = await client.query(
        `
          insert into recording_tasks (recording_id, summary_id, transcript_id, assignee, description, due_text)
          values ($1, $2, $3, $4, $5, $6)
          returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, status, created_at, updated_at
        `,
        [recordingId, summary.id, recording.transcript.id, task.assignee || null, task.description, task.dueText || null],
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
  const title = hasTitle && typeof data.title === 'string' ? data.title.trim() : null;
  const projectId = hasProjectId && typeof data.projectId === 'string' && data.projectId.trim() ? data.projectId.trim() : null;

  if (hasTitle && !title) {
    throw new Error('Recording title is required');
  }

  const result = await query(
    `
      update recordings
      set
        title = case when $3 then $4 else recordings.title end,
        project_id = case when $5 then $6::uuid else recordings.project_id end,
        auto_named = case when $3 then false else recordings.auto_named end,
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
        recordings.auto_named,
        (select name from projects where projects.id = recordings.project_id) as project_name,
        (select color from projects where projects.id = recordings.project_id) as project_color
    `,
    [recordingId, ownerId, hasTitle, title, hasProjectId, projectId],
  );

  return result.rowCount ? mapRecording(result.rows[0]) : null;
}

export async function createRecordingTask(recordingId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const assignee = typeof data.assignee === 'string' && data.assignee.trim() ? data.assignee.trim() : null;
  const dueText = typeof data.dueText === 'string' && data.dueText.trim() ? data.dueText.trim() : null;

  if (!description) {
    throw new Error('Task description is required');
  }

  const result = await query(
    `
      insert into recording_tasks (recording_id, summary_id, transcript_id, assignee, description, due_text, status)
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
        'confirmed'
      from recordings recording
      where recording.id = $1
        and (recording.owner_id = $2 or recording.owner_id is null)
      returning id, recording_id, summary_id, transcript_id, assignee, description, due_text, status, created_at, updated_at
    `,
    [recordingId, ownerId, assignee, description, dueText],
  );

  return result.rowCount ? mapTask(result.rows[0]) : null;
}

export async function updateRecordingTask(recordingId, taskId, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const hasAssignee = Object.prototype.hasOwnProperty.call(data, 'assignee');
  const hasDescription = Object.prototype.hasOwnProperty.call(data, 'description');
  const hasDueText = Object.prototype.hasOwnProperty.call(data, 'dueText');
  const hasStatus = Object.prototype.hasOwnProperty.call(data, 'status');
  const assignee =
    hasAssignee && typeof data.assignee === 'string' && data.assignee.trim() ? data.assignee.trim() : null;
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

  const result = await query(
    `
      update recording_tasks task
      set
        assignee = case when $4 then $5 else task.assignee end,
        description = case when $6 then $7 else task.description end,
        due_text = case when $8 then $9 else task.due_text end,
        status = case when $10 then $11 else task.status end,
        updated_at = now()
      from recordings recording
      where task.id = $1
        and task.recording_id = $2
        and recording.id = task.recording_id
        and (recording.owner_id = $3 or recording.owner_id is null)
      returning task.id, task.recording_id, task.summary_id, task.transcript_id,
        task.assignee, task.description, task.due_text, task.status, task.created_at, task.updated_at
    `,
    [taskId, recordingId, ownerId, hasAssignee, assignee, hasDescription, description, hasDueText, dueText, hasStatus, status],
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

export async function updateRecordingSpeaker(recordingId, label, ownerId, input) {
  const data = input && typeof input === 'object' ? input : {};
  const displayName = typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : formatSpeakerLabel(label);
  const contactName = typeof data.contactName === 'string' && data.contactName.trim() ? data.contactName.trim() : null;
  const contactEmail = typeof data.contactEmail === 'string' && data.contactEmail.trim() ? data.contactEmail.trim() : null;

  if (!String(label || '').trim()) {
    throw new Error('Speaker label is required');
  }

  const result = await query(
    `
      insert into recording_speakers (recording_id, label, display_name, contact_name, contact_email)
      select recording.id, $2, $4, $5, $6
      from recordings recording
      where recording.id = $1
        and (recording.owner_id = $3 or recording.owner_id is null)
      on conflict (recording_id, label)
      do update set
        display_name = excluded.display_name,
        contact_name = excluded.contact_name,
        contact_email = excluded.contact_email,
        updated_at = now()
      returning id, recording_id, label, display_name, contact_name, contact_email, created_at, updated_at
    `,
    [recordingId, label, ownerId, displayName, contactName, contactEmail],
  );

  return result.rowCount ? mapSpeaker(result.rows[0]) : null;
}

export async function getRecordingAudio(id, ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at,
        original_filename, mime_type, file_size_bytes
      from recordings
      where id = $1 and (owner_id = $2 or owner_id is null)
    `,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const recording = result.rows[0];

  if (!recording.storage_key) {
    return { recording: mapRecording(recording), stream: null };
  }

  const stream = await getRecordingAudioStream(recording.storage_key);

  return {
    recording: mapRecording(recording),
    stream,
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

  const queueJob = await queue.add('process-recording', {
    jobId: job.id,
    recordingId,
  });

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

export async function attachRecordingAudio(recordingId, file, ownerId) {
  const recording = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
    recordingId,
    ownerId,
  ]);

  if (recording.rowCount === 0) {
    return null;
  }

  const metadata = await saveRecordingAudio(recordingId, file);
  const result = await query(
    `
      update recordings
      set
        storage_key = $1,
        original_filename = $2,
        mime_type = $3,
        file_size_bytes = $4,
        status = 'uploaded',
        updated_at = now()
      where id = $5
      returning id, owner_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, created_at, updated_at
    `,
    [metadata.storageKey, metadata.originalFilename, metadata.mimeType, metadata.fileSizeBytes, recordingId],
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
    const audio = await getRecordingAudio(c.req.param('id'), user.id);

    if (!audio) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    if (!audio.stream) {
      return c.json({ error: 'Recording audio not found' }, 404);
    }

    const filename = audio.recording.originalFilename || 'recording-audio';
    const headers = {
      'Content-Type': audio.recording.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    };

    if (audio.recording.fileSizeBytes) {
      headers['Content-Length'] = String(audio.recording.fileSizeBytes);
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

  app.post('/api/recordings/:id/audio', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const formData = await c.req.raw.formData().catch(() => null);
    const file = formData?.get('file');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: 'Expected multipart form-data with file field named "file"' }, 400);
    }

    const recording = await attachRecordingAudio(c.req.param('id'), file, user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording });
  });

  app.post('/api/recordings/:id/jobs', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const job = await enqueueRecording(c.req.param('id'), user.id);

    if (!job) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ job }, 202);
  });

  app.post('/api/recordings/:id/summary', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const result = await summarizeRecording(c.req.param('id'), user.id);

      if (!result) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: error.message || 'Failed to summarize recording' }, 400);
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

  app.delete('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteRecording(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording: deleted });
  });
}
