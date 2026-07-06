import dotenv from 'dotenv';
import { Worker } from 'bullmq';
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
import { transcribeWithSpeech2Text, checkSpeech2TextStatus, fetchSpeech2TextResult, parseSpeech2TextResult } from './speech2textDiarizer.js';
import { getUserDiarizationConfig } from './auth.js';

dotenv.config();

// Diarizing a long meeting on CPU can take well over the default 5-minute
// undici headers/body timeout used by Node's global fetch. This is a trusted
// internal worker process, not user-facing, so disabling the timeout is safe.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

async function processRecording(data) {
  const { jobId, recordingId } = data;

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
        set status = 'processing', updated_at = now()
        where id = $1
      `,
      [recordingId],
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
  }

  let finalText;
  let finalSegments;

  if (diarized) {
    console.log(`Diarized recording ${recordingId} into ${diarized.speakerCount} speakers via ${diarizationMethod}`);
    finalText = diarized.text;
    finalSegments = diarized.segments;
  } else {
    const transcription = await transcribeWithOpenRouter(file, audioBuffer);
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
        insert into transcripts (recording_id, job_id, language, text, segments)
        values ($1, $2, 'ru', $3, $4::jsonb)
      `,
      [recordingId, jobId, finalText, JSON.stringify(finalSegments)],
    );

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
}

const MEETING_BOT_POLL_INTERVAL_MS = Number(process.env.MEETING_BOT_POLL_INTERVAL_MS || 30000);

async function ingestCompletedMeeting(recording, statusBody) {
  const statusCode = statusBody?.status?.code;

  await transaction(async (client) => {
    let finalText = 'В записи встречи не обнаружено речи.';
    let finalSegments = [];

    if (statusCode === 200) {
      const result = await fetchSpeech2TextResult(recording.meeting_bot_task_id, recording.apiKey);
      const parsed = parseSpeech2TextResult(result);

      if (parsed) {
        finalText = parsed.text;
        finalSegments = parsed.segments;
      }
    }

    await client.query(
      `insert into transcripts (recording_id, job_id, language, text, segments)
       select $1, id, 'ru', $2, $3::jsonb from processing_jobs where recording_id = $1 order by created_at desc limit 1`,
      [recording.id, finalText, JSON.stringify(finalSegments)],
    );

    await client.query(
      `update processing_jobs set status = 'done', error = null, updated_at = now()
       where recording_id = $1 and status = 'processing'`,
      [recording.id],
    );

    await client.query(`update recordings set status = 'done', updated_at = now() where id = $1`, [recording.id]);
  });

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

async function main() {
  await runMigrations();
  await ensureAudioBucket();

  setInterval(() => {
    pollMeetingBotRecordings().catch((error) => console.warn('Meeting bot poll loop error:', error.message));
  }, MEETING_BOT_POLL_INTERVAL_MS);

  const worker = new Worker(
    RECORDING_QUEUE_NAME,
    async (job) => {
      await processRecording(job.data);
    },
    {
      connection: createRedisConnection(),
    },
  );

  worker.on('completed', (job) => {
    console.log(`Completed recording job ${job.id}`);
  });

  worker.on('failed', async (job, error) => {
    console.error(`Failed recording job ${job?.id}:`, error);

    if (job && job.attemptsMade < (job.opts.attempts || 1)) {
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

        await client.query(
          `
            update recordings
            set status = 'failed', updated_at = now()
            where id = $1
          `,
          [job.data.recordingId],
        );
      });
    }
  });

  console.log(`VoxMate worker listening on ${RECORDING_QUEUE_NAME}`);
}

main().catch((error) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
