import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';
import { query, transaction } from './db.js';
import { runMigrations } from './migrations.js';
import { createRedisConnection, RECORDING_QUEUE_NAME } from './queue.js';
import { ensureAudioBucket, getRecordingAudioBuffer } from './storage.js';
import { trySplitTranscriptBySpeaker } from './speakerSplit.js';

dotenv.config();

// Diarizing a long meeting on CPU can take well over the default 5-minute
// undici headers/body timeout used by Node's global fetch. This is a trusted
// internal worker process, not user-facing, so disabling the timeout is safe.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const ASR_COMPRESS_THRESHOLD_BYTES = Number(process.env.ASR_COMPRESS_THRESHOLD_BYTES || 20 * 1024 * 1024);
const ASR_MAX_RETRIES = Number(process.env.ASR_MAX_RETRIES || 3);

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

async function prepareAudioForAsr(file, audioBuffer) {
  if (audioBuffer.length <= ASR_COMPRESS_THRESHOLD_BYTES) {
    return {
      buffer: audioBuffer,
      format: getAudioFormat(file),
      compressed: false,
    };
  }

  const workdir = path.join(tmpdir(), `voxmate-asr-${randomUUID()}`);
  const inputFormat = getAudioFormat(file);
  const inputPath = path.join(workdir, `input.${inputFormat || 'audio'}`);
  const outputPath = path.join(workdir, 'asr.mp3');

  await mkdir(workdir, { recursive: true });

  try {
    await writeFile(inputPath, audioBuffer);
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      process.env.ASR_COMPRESSED_BITRATE || '32k',
      outputPath,
    ]);

    const compressed = await readFile(outputPath);
    console.log(
      `Compressed ASR audio ${file.original_filename || file.storage_key}: ${audioBuffer.length} -> ${compressed.length} bytes`,
    );

    return {
      buffer: compressed,
      format: 'mp3',
      compressed: true,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function callOpenRouterAsr(payload) {
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'VoxMate',
    },
    body: JSON.stringify({
      input_audio: {
        data: payload.audioBuffer.toString('base64'),
        format: payload.format,
      },
      model: process.env.OPENROUTER_ASR_MODEL || 'openai/whisper-large-v3',
      language: process.env.OPENROUTER_ASR_LANGUAGE || 'ru',
    }),
  });
  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const message = responseBody?.error?.message || responseBody?.message || `OpenRouter ASR failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return responseBody;
}

async function transcribeWithOpenRouter(file, audioBuffer) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  const preparedAudio = await prepareAudioForAsr(file, audioBuffer);

  for (let attempt = 1; attempt <= ASR_MAX_RETRIES; attempt += 1) {
    try {
      const responseBody = await callOpenRouterAsr({
        apiKey,
        audioBuffer: preparedAudio.buffer,
        format: preparedAudio.format,
      });

      return {
        text: responseBody?.text || '',
        usage: responseBody?.usage || null,
        compressed: preparedAudio.compressed,
      };
    } catch (error) {
      const canRetry = isRetryableStatus(error.status) && attempt < ASR_MAX_RETRIES;

      if (!canRetry) {
        error.message = `${error.message}. Audio payload: ${Math.round(preparedAudio.buffer.length / 1024 / 1024)} MB ${preparedAudio.compressed ? '(compressed)' : '(original)'}`;
        throw error;
      }

      const delayMs = attempt * 5000;
      console.warn(`OpenRouter ASR attempt ${attempt} failed with ${error.status}; retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  return null;
}

function formatDiarizerSpeakerLabel(label) {
  const match = String(label || '').match(/SPEAKER_?(\d+)/i);

  return match ? `Спикер ${Number(match[1]) + 1}` : String(label || 'Спикер 1');
}

function mergeDiarizerSegments(segments) {
  const merged = [];

  for (const segment of segments) {
    const speaker = formatDiarizerSpeakerLabel(segment.speaker);
    const last = merged[merged.length - 1];

    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${segment.text}`.trim();
      last.endMs = Math.round((segment.end || 0) * 1000);
    } else {
      merged.push({
        speaker,
        text: segment.text,
        startMs: Math.round((segment.start || 0) * 1000),
        endMs: Math.round((segment.end || 0) * 1000),
      });
    }
  }

  return merged;
}

async function transcribeWithDiarizer(file, audioBuffer) {
  const diarizerUrl = process.env.DIARIZER_URL;

  if (!diarizerUrl || !audioBuffer) {
    return null;
  }

  try {
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audioBuffer], { type: file?.mime_type || 'application/octet-stream' }),
      file?.original_filename || 'audio',
    );

    const response = await fetch(`${diarizerUrl}/diarize`, { method: 'POST', body: formData });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.detail || `Diarizer failed with ${response.status}`);
    }

    const rawSegments = Array.isArray(body?.segments) ? body.segments.filter((segment) => segment.text?.trim()) : [];

    if (!rawSegments.length) {
      return null;
    }

    const segments = mergeDiarizerSegments(rawSegments);

    return {
      text: segments.map((segment) => `${segment.speaker}\n${segment.text}`).join('\n\n'),
      segments,
      speakerCount: new Set(segments.map((segment) => segment.speaker)).size,
    };
  } catch (error) {
    console.warn('Diarizer transcription failed, falling back to OpenRouter ASR:', error.message);
    return null;
  }
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
  const audioBuffer = file?.storage_key ? await getRecordingAudioBuffer(file.storage_key) : null;

  const diarized = await transcribeWithDiarizer(file, audioBuffer);

  let finalText;
  let finalSegments;

  if (diarized) {
    console.log(`Diarized recording ${recordingId} into ${diarized.speakerCount} speakers via WhisperX`);
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
