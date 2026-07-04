import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import { query, transaction } from './db.js';
import { runMigrations } from './migrations.js';
import { createRedisConnection, RECORDING_QUEUE_NAME } from './queue.js';
import { ensureAudioBucket } from './storage.js';

dotenv.config();

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
  const transcriptText = file?.storage_key
    ? `Audio file received for "${title}": ${file.original_filename || 'unnamed file'}, ${file.mime_type || 'unknown type'}, ${file.file_size_bytes || 0} bytes. ASR integration will replace this worker step.`
    : `Mock transcript for "${title}". No audio file is attached yet.`;

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
