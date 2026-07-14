import dotenv from 'dotenv';
import { Worker, UnrecoverableError } from 'bullmq';
import { Agent, setGlobalDispatcher } from 'undici';
import { query, transaction } from './db.js';
import { runMigrations } from './migrations.js';
import { createRedisConnection, RECORDING_QUEUE_NAME } from './queue.js';
import { ensureAudioBucket, getRecordingAudioBuffer, replaceRecordingAudio } from './storage.js';
import { trySplitTranscriptBySpeaker } from './speakerSplit.js';
import { transcribeWithOpenRouter } from './openrouterAsr.js';
import { isVideoContainer, extractAudioTrack } from './videoAudio.js';
import { transcribeWithShopot } from './shopotDiarizer.js';
import { transcribeWithGeminiAudio } from './geminiDiarizer.js';
import { transcribeWithKimi } from './kimiDiarizer.js';
import { transcribeWithAccuratePipeline } from './pipelineDiarizer.js';
import { transcribeWithSpeech2Text, checkSpeech2TextStatus, fetchSpeech2TextResult, parseSpeech2TextResult } from './speech2textDiarizer.js';
import { getUserDiarizationConfig } from './auth.js';
import { summarizeRecording } from './recordings.js';
import { notifyRecordingEvent, notifyTaskOverdue } from './notifications.js';

dotenv.config();

// Diarizing a long meeting on CPU can take well over the default 5-minute
// undici headers/body timeout used by Node's global fetch. This is a trusted
// internal worker process, not user-facing, so disabling the timeout is safe.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const CANCELLED_MESSAGE = 'Отменено пользователем';

async function checkCancelled(jobId) {
  const result = await query('select cancel_requested from processing_jobs where id = $1', [jobId]);

  if (result.rows[0]?.cancel_requested) {
    // UnrecoverableError tells BullMQ to skip its remaining retry attempts -
    // a user-requested cancellation should stop immediately, not get
    // auto-retried like a transient failure.
    throw new UnrecoverableError(CANCELLED_MESSAGE);
  }
}

async function processRecording(data) {
  const { jobId, recordingId } = data;

  await checkCancelled(jobId);

  // Checkpoint: BullMQ retries re-run this same job from the top. If a
  // transcript already exists from an earlier (partially successful)
  // attempt, skip straight to summarization instead of re-transcribing -
  // this is what makes a summarization-only failure retry as a
  // summarization-only retry (US-4.3), without a second job/queue.
  const existingTranscript = await query('select id from transcripts where recording_id = $1 order by created_at desc limit 1', [
    recordingId,
  ]);
  const alreadyTranscribed = existingTranscript.rowCount > 0;

  await transaction(async (client) => {
    await client.query(
      `
        update processing_jobs
        set status = 'processing', updated_at = now()
        where id = $1
      `,
      [jobId],
    );

    await client.query(
      `
        update recordings
        set status = $2, updated_at = now()
        where id = $1
      `,
      [recordingId, alreadyTranscribed ? 'summarizing' : 'transcribing'],
    );
  });

  const recording = await query(
    `
      select owner_id, title, original_filename, mime_type, file_size_bytes, storage_key
      from recordings
      where id = $1
    `,
    [recordingId],
  );
  const title = recording.rows[0]?.title || 'recording';
  const file = recording.rows[0];

  if (alreadyTranscribed) {
    await summarizeRecording(recordingId, file?.owner_id);

    await transaction(async (client) => {
      await client.query(`update processing_jobs set status = 'done', error = null, updated_at = now() where id = $1`, [jobId]);
      await client.query(`update recordings set status = 'done', updated_at = now() where id = $1`, [recordingId]);
    });
    await notifyRecordingEvent(recordingId, file?.owner_id, 'done');
    return;
  }

  let audioBuffer = file?.storage_key ? await getRecordingAudioBuffer(file.storage_key) : null;

  if (audioBuffer && isVideoContainer(file)) {
    const extracted = await extractAudioTrack(file, audioBuffer);
    audioBuffer = extracted.buffer;

    const metadata = await replaceRecordingAudio(
      recordingId,
      file.storage_key,
      extracted.buffer,
      extracted.originalFilename,
      extracted.mimeType,
    );

    await query(
      `
        update recordings
        set storage_key = $1, original_filename = $2, mime_type = $3, file_size_bytes = $4, updated_at = now()
        where id = $5
      `,
      [metadata.storageKey, metadata.originalFilename, metadata.mimeType, metadata.fileSizeBytes, recordingId],
    );

    file.storage_key = metadata.storageKey;
    file.original_filename = metadata.originalFilename;
    file.mime_type = metadata.mimeType;
    file.file_size_bytes = metadata.fileSizeBytes;
  }

  const diarizationConfig = file?.owner_id ? (await getUserDiarizationConfig(file.owner_id)) || {} : {};
  const diarizationMethod = diarizationConfig.method || 'shopot';

  let diarized = null;

  if (diarizationMethod === 'shopot') {
    diarized = await transcribeWithShopot(file, audioBuffer, diarizationConfig);
  } else if (diarizationMethod === 'gemini') {
    diarized = await transcribeWithGeminiAudio(file, audioBuffer, diarizationConfig);
  } else if (diarizationMethod === 'speech2text') {
    diarized = await transcribeWithSpeech2Text(file, audioBuffer, diarizationConfig);
  } else if (diarizationMethod === 'kimi') {
    diarized = await transcribeWithKimi(file, audioBuffer, diarizationConfig);
  } else if (diarizationMethod === 'pipeline') {
    diarized = await transcribeWithAccuratePipeline(file, audioBuffer, diarizationConfig);
  }

  let finalText;
  let finalSegments;
  // A manual override always wins; otherwise fall back to whatever the ASR
  // step actually detected (only some diarization methods surface this -
  // see openrouterAsr.js/pipelineDiarizer.js/kimiDiarizer.js), then 'ru'.
  let resolvedLanguage = diarizationConfig.language || null;

  if (diarized) {
    console.log(`Diarized recording ${recordingId} into ${diarized.speakerCount} speakers via ${diarizationMethod}`);
    finalText = diarized.text;
    finalSegments = diarized.segments;
    resolvedLanguage = resolvedLanguage || diarized.language || 'ru';
  } else {
    const transcription = await transcribeWithOpenRouter(file, audioBuffer, { language: diarizationConfig.language || undefined });
    resolvedLanguage = resolvedLanguage || transcription?.language || 'ru';
    const transcriptText =
      transcription?.text ||
      (file?.storage_key
        ? `Audio file received for "${title}", but OpenRouter ASR is not configured.`
        : `Mock transcript for "${title}". No audio file is attached yet.`);

    const speakerSplit = await trySplitTranscriptBySpeaker(transcriptText);

    if (speakerSplit) {
      console.log(`Split transcript for recording ${recordingId} into ${speakerSplit.speakerCount} speakers`);
    }

    finalText = speakerSplit?.text || transcriptText;
    finalSegments = speakerSplit?.segments || [
      {
        startMs: 0,
        endMs: 3000,
        speaker: 'speaker_1',
        text: transcriptText,
        usage: transcription?.usage || null,
      },
    ];
  }

  await transaction(async (client) => {
    await client.query(
      `
        insert into transcripts (recording_id, job_id, language, text, segments, original_text, original_segments)
        values ($1, $2, $3, $4, $5::jsonb, $4, $5::jsonb)
      `,
      [recordingId, jobId, resolvedLanguage, finalText, JSON.stringify(finalSegments)],
    );
  });

  // Persist any speaker-identity guesses as pending suggestions (US-7.1) -
  // only the accuracy pipeline resolves identities at all today. Segments
  // themselves already stayed on stable "Спикер N" labels (see
  // pipelineDiarizer.js's resolveSpeakerLabels), so this never silently
  // renames anyone - it's purely a suggestion row for the user to accept or
  // reject later.
  if (diarized?.identities && Object.keys(diarized.identities).length > 0) {
    for (const [label, identity] of Object.entries(diarized.identities)) {
      await query(
        `
          insert into recording_speakers (recording_id, label, display_name, suggested_name, suggestion_confidence, suggestion_evidence, suggestion_status)
          values ($1, $2, $2, $3, $4, $5, 'pending')
          on conflict (recording_id, label) do update
          set suggested_name = excluded.suggested_name,
              suggestion_confidence = excluded.suggestion_confidence,
              suggestion_evidence = excluded.suggestion_evidence,
              suggestion_status = 'pending',
              updated_at = now()
        `,
        [recordingId, label, identity.suggestedName, identity.confidence, identity.evidence],
      );
    }
  }

  // Stage boundary: if cancellation was requested while transcription was
  // in flight, stop here instead of starting the protocol/tasks LLM call -
  // the transcript we just wrote stays, so a future "restart" would resume
  // straight into summarization rather than re-transcribing.
  await checkCancelled(jobId);

  await query(`update recordings set status = 'summarizing', updated_at = now() where id = $1`, [recordingId]);
  await summarizeRecording(recordingId, file?.owner_id);

  await transaction(async (client) => {
    await client.query(
      `
        update processing_jobs
        set status = 'done', error = null, updated_at = now()
        where id = $1
      `,
      [jobId],
    );

    await client.query(
      `
        update recordings
        set status = 'done', updated_at = now()
        where id = $1
      `,
      [recordingId],
    );
  });

  await notifyRecordingEvent(recordingId, file?.owner_id, 'done');
}

const MEETING_BOT_POLL_INTERVAL_MS = Number(process.env.MEETING_BOT_POLL_INTERVAL_MS || 30000);

async function ingestCompletedMeeting(recording, statusBody) {
  const statusCode = statusBody?.status?.code;
  const diarizationConfig = recording.owner_id ? (await getUserDiarizationConfig(recording.owner_id)) || {} : {};
  const language = diarizationConfig.language || 'ru';

  // Fetched outside the transaction - an external HTTP call has no business
  // holding a DB connection/transaction open for its full duration.
  let finalText = 'В записи встречи не обнаружено речи.';
  let finalSegments = [];
  let hasSpeech = false;

  if (statusCode === 200) {
    const result = await fetchSpeech2TextResult(recording.meeting_bot_task_id, recording.apiKey);
    const parsed = parseSpeech2TextResult(result);

    if (parsed) {
      finalText = parsed.text;
      finalSegments = parsed.segments;
      hasSpeech = true;
    }
  }

  await transaction(async (client) => {
    await client.query(
      `insert into transcripts (recording_id, job_id, language, text, segments, original_text, original_segments)
       select $1, id, $2, $3, $4::jsonb, $3, $4::jsonb from processing_jobs where recording_id = $1 order by created_at desc limit 1`,
      [recording.id, language, finalText, JSON.stringify(finalSegments)],
    );

    await client.query(
      `update processing_jobs set status = 'done', error = null, updated_at = now()
       where recording_id = $1 and status = 'processing'`,
      [recording.id],
    );

    await client.query(`update recordings set status = $2, updated_at = now() where id = $1`, [
      recording.id,
      hasSpeech ? 'summarizing' : 'done',
    ]);
  });

  // Same protocol/tasks generation the file-upload pipeline runs after
  // transcription - a meeting-bot recording shouldn't land as "Готово" with
  // a bare transcript and no protocol. A summarization failure keeps the
  // transcript (the user can regenerate manually), it doesn't fail the
  // whole ingest.
  if (hasSpeech) {
    try {
      await summarizeRecording(recording.id, recording.owner_id);
    } catch (error) {
      console.warn(`Meeting bot summarization failed for recording ${recording.id}:`, error.message);
    } finally {
      await query(`update recordings set status = 'done', updated_at = now() where id = $1`, [recording.id]);
    }
  }

  await notifyRecordingEvent(recording.id, recording.owner_id, 'done');
  console.log(`Meeting bot recording ${recording.id} finished (${finalSegmentsCountLabel(statusCode)})`);
}

function finalSegmentsCountLabel(statusCode) {
  return statusCode === 200 ? 'transcript ingested' : 'no speech detected';
}

async function failMeeting(recording, message) {
  await transaction(async (client) => {
    await client.query(
      `update processing_jobs set status = 'failed', error = $2, updated_at = now()
       where recording_id = $1 and status = 'processing'`,
      [recording.id, message],
    );
    await client.query(`update recordings set status = 'failed', updated_at = now() where id = $1`, [recording.id]);
  });

  await notifyRecordingEvent(recording.id, recording.owner_id, 'failed');
  console.warn(`Meeting bot recording ${recording.id} failed: ${message}`);
}

/**
 * Periodically checks Speech2Text meeting-bot tasks that are still
 * in-progress (bot joined/recording a live meeting) and ingests the
 * transcript once the task completes, or marks the recording failed on
 * error. There's no BullMQ job for this - the bot can take as long as the
 * meeting itself, so a lightweight poll loop fits better than a queue slot.
 */
async function pollMeetingBotRecordings() {
  const pending = await query(
    `select id, owner_id, meeting_bot_task_id
     from recordings
     where source = 'meeting_bot' and status = 'processing' and meeting_bot_task_id is not null`,
  );

  for (const row of pending.rows) {
    try {
      const diarizationConfig = (await getUserDiarizationConfig(row.owner_id)) || {};
      const apiKey = diarizationConfig.speech2textApiKey || process.env.SPEECH2TEXT_API_KEY;

      if (!apiKey) {
        continue;
      }

      const statusBody = await checkSpeech2TextStatus(row.meeting_bot_task_id, apiKey);
      const value = statusBody?.status?.value;

      if (value === 'done') {
        await ingestCompletedMeeting({ ...row, apiKey }, statusBody);
      } else if (value === 'error') {
        await failMeeting(row, statusBody?.status?.description || 'Speech2Text meeting task failed');
      }
      // 'queued' (bot joining/recording) and 'paused' (minute limit) are left as-is.
    } catch (error) {
      console.warn(`Meeting bot poll failed for recording ${row.id}:`, error.message);
    }
  }
}

const OVERDUE_TASK_POLL_INTERVAL_MS = Number(process.env.OVERDUE_TASK_POLL_INTERVAL_MS || 30 * 60 * 1000);

/**
 * US-9.3: "Просроченная дата → уведомление". Runs independently of the
 * recording pipeline (a task can become overdue at any moment, not just
 * around a processing event), same setInterval-poll shape as
 * pollMeetingBotRecordings above. overdue_notified_at guards against
 * re-notifying on every poll tick once a task has already been flagged.
 */
async function pollOverdueTasks() {
  const overdue = await query(
    `
      select task.id, task.description, task.due_text, recording.id as recording_id, recording.owner_id
      from recording_tasks task
      join recordings recording on recording.id = task.recording_id
      where task.due_date is not null
        and task.due_date < now()
        and task.status not in ('done', 'dismissed')
        and task.overdue_notified_at is null
        and recording.owner_id is not null
    `,
  );

  for (const row of overdue.rows) {
    try {
      await notifyTaskOverdue(row.owner_id, row.recording_id, { description: row.description, dueText: row.due_text });
      await query('update recording_tasks set overdue_notified_at = now() where id = $1', [row.id]);
    } catch (error) {
      console.warn(`Overdue-task notification failed for task ${row.id}:`, error.message);
    }
  }
}

async function main() {
  await runMigrations();
  await ensureAudioBucket();

  setInterval(() => {
    pollMeetingBotRecordings().catch((error) => console.warn('Meeting bot poll loop error:', error.message));
  }, MEETING_BOT_POLL_INTERVAL_MS);

  setInterval(() => {
    pollOverdueTasks().catch((error) => console.warn('Overdue task poll loop error:', error.message));
  }, OVERDUE_TASK_POLL_INTERVAL_MS);

  const worker = new Worker(
    RECORDING_QUEUE_NAME,
    async (job) => {
      await processRecording(job.data);
    },
    {
      connection: createRedisConnection(),
      concurrency: Number(process.env.RECORDING_WORKER_CONCURRENCY || 3),
    },
  );

  worker.on('completed', (job) => {
    console.log(`Completed recording job ${job.id}`);
  });

  worker.on('failed', async (job, error) => {
    console.error(`Failed recording job ${job?.id}:`, error);

    // UnrecoverableError (thrown by checkCancelled) skips BullMQ's own
    // retry count, so it must also skip this attemptsMade gate - otherwise
    // a cancellation on an early attempt would be silently swallowed here
    // and never persisted as 'failed'.
    const isCancelled = error instanceof UnrecoverableError && error.message === CANCELLED_MESSAGE;
    const isFinalAttempt = !job || isCancelled || job.attemptsMade >= (job.opts.attempts || 1);

    if (!isFinalAttempt) {
      return;
    }

    if (job?.data?.jobId && job?.data?.recordingId) {
      await transaction(async (client) => {
        await client.query(
          `
            update processing_jobs
            set status = 'failed', error = $1, updated_at = now()
            where id = $2
          `,
          [error.message, job.data.jobId],
        );

        // A user cancellation isn't a "the system is broken" failure, so it
        // shouldn't count toward the repeated-failure/critical threshold
        // (US-4.3) that offers the user a support contact.
        await client.query(
          isCancelled
            ? `update recordings set status = 'failed', updated_at = now() where id = $1`
            : `update recordings set status = 'failed', failure_count = failure_count + 1, updated_at = now() where id = $1`,
          [job.data.recordingId],
        );
      });

      // A cancellation was the user's own action - notifying them "your
      // recording failed" about something they just cancelled themselves
      // would be confusing, so only genuine failures notify.
      if (!isCancelled) {
        const owner = await query('select owner_id from recordings where id = $1', [job.data.recordingId]);
        await notifyRecordingEvent(job.data.recordingId, owner.rows[0]?.owner_id, 'failed');
      }
    }
  });

  console.log(`VoxMate worker listening on ${RECORDING_QUEUE_NAME}`);
}

main().catch((error) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
