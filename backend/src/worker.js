import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import { query, transaction } from './db.js';
import { runMigrations } from './migrations.js';
import { createRedisConnection, RECORDING_QUEUE_NAME } from './queue.js';
import { ensureAudioBucket, getRecordingAudioBuffer } from './storage.js';

dotenv.config();

function getAudioFormat(file) {
  const filename = file?.original_filename || '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  if (extension) {
    return extension === 'mpeg' ? 'mp3' : extension;
  }

  if (file?.mime_type?.includes('/')) {
    return file.mime_type.split('/').pop().toLowerCase();
  }

  return 'mp3';
}

async function transcribeWithOpenRouter(file) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !file?.storage_key) {
    return null;
  }

  const audioBuffer = await getRecordingAudioBuffer(file.storage_key);

  if (!audioBuffer) {
    return null;
  }

  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'VoxMate',
    },
    body: JSON.stringify({
      input_audio: {
        data: audioBuffer.toString('base64'),
        format: getAudioFormat(file),
      },
      model: process.env.OPENROUTER_ASR_MODEL || 'openai/whisper-large-v3',
      language: process.env.OPENROUTER_ASR_LANGUAGE || 'ru',
    }),
  });

  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const message = responseBody?.error?.message || responseBody?.message || `OpenRouter ASR failed with ${response.status}`;
    throw new Error(message);
  }

  return {
    text: responseBody?.text || '',
    usage: responseBody?.usage || null,
  };
}

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
      select title, original_filename, mime_type, file_size_bytes, storage_key
      from recordings
      where id = $1
    `,
    [recordingId],
  );
  const title = recording.rows[0]?.title || 'recording';
  const file = recording.rows[0];
  const transcription = await transcribeWithOpenRouter(file);
  const transcriptText =
    transcription?.text ||
    (file?.storage_key
      ? `Audio file received for "${title}", but OpenRouter ASR is not configured.`
      : `Mock transcript for "${title}". No audio file is attached yet.`);

  await transaction(async (client) => {
    await client.query(
      `
        insert into transcripts (recording_id, job_id, language, text, segments)
        values ($1, $2, 'ru', $3, $4::jsonb)
      `,
      [
        recordingId,
        jobId,
        transcriptText,
        JSON.stringify([
          {
            startMs: 0,
            endMs: 3000,
            speaker: 'speaker_1',
            text: transcriptText,
            usage: transcription?.usage || null,
          },
        ]),
      ],
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

async function main() {
  await runMigrations();
  await ensureAudioBucket();

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
