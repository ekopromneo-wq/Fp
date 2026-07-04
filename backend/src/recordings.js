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
    title: row.title,
    status: row.status,
    source: row.source,
    durationSeconds: row.duration_seconds,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
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

export async function listRecordings(ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at
      , original_filename, mime_type, file_size_bytes
      from recordings
      where owner_id = $1 or owner_id is null
      order by created_at desc
      limit 50
    `,
    [ownerId],
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
      returning id, owner_id, title, status, source, duration_seconds, storage_key,
        original_filename, mime_type, file_size_bytes, created_at, updated_at
    `,
    [ownerId, title, source, input.durationSeconds || null, input.storageKey || null],
  );

  return mapRecording(result.rows[0]);
}

export async function getRecording(id, ownerId) {
  const result = await query(
    `
      select id, owner_id, title, status, source, duration_seconds, storage_key, created_at, updated_at
      , original_filename, mime_type, file_size_bytes
      from recordings
      where id = $1 and (owner_id = $2 or owner_id is null)
    `,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const [jobs, transcript] = await Promise.all([
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
  ]);

  return {
    ...mapRecording(result.rows[0]),
    jobs: jobs.rows.map(mapJob),
    transcript: mapTranscript(transcript.rows[0]),
  };
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
  app.get('/api/recordings', requireAuth, async (c) => {
    const user = getAuthUser(c);

    return c.json({
      recordings: await listRecordings(user.id),
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

  app.delete('/api/recordings/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const deleted = await deleteRecording(c.req.param('id'), user.id);

    if (!deleted) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ recording: deleted });
  });
}
