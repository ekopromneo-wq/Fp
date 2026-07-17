import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAudioFormat, runFfmpeg } from './ffmpeg.js';

const ASR_COMPRESS_THRESHOLD_BYTES = Number(process.env.ASR_COMPRESS_THRESHOLD_BYTES || 20 * 1024 * 1024);
const ASR_MAX_RETRIES = Number(process.env.ASR_MAX_RETRIES || 3);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status < 600);
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
  const body = {
    input_audio: {
      data: payload.audioBuffer.toString('base64'),
      format: payload.format,
    },
    model: payload.model || process.env.OPENROUTER_ASR_MODEL || 'openai/whisper-large-v3',
    language: payload.language || process.env.OPENROUTER_ASR_LANGUAGE || 'ru',
  };

  if (payload.responseFormat) {
    body.response_format = payload.responseFormat;
  }

  if (payload.timestampGranularities) {
    body.timestamp_granularities = payload.timestampGranularities;
  }

  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${payload.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'Stenogram',
    },
    body: JSON.stringify(body),
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

/**
 * Retries an OpenRouter /audio/transcriptions call with linear backoff,
 * shared by both the plain-text and timestamped transcription helpers below.
 * `attemptFn` performs one attempt and must throw an Error with a `.status`
 * (set by callOpenRouterAsr) on HTTP failure. `describePayload` is only used
 * to annotate the final error message once retries are exhausted.
 */
async function withAsrRetries(attemptFn, describePayload) {
  for (let attempt = 1; attempt <= ASR_MAX_RETRIES; attempt += 1) {
    try {
      return await attemptFn();
    } catch (error) {
      const canRetry = isRetryableStatus(error.status) && attempt < ASR_MAX_RETRIES;

      if (!canRetry) {
        error.message = `${error.message}. ${describePayload()}`;
        throw error;
      }

      const delayMs = attempt * 5000;
      console.warn(`OpenRouter ASR attempt ${attempt} failed with ${error.status}; retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  return null;
}

/**
 * Plain ASR transcription (no diarization) via OpenRouter's /audio/transcriptions
 * endpoint. Shared by worker.js (as the ultimate fallback) and text-based
 * diarization methods (like Kimi) that need a transcript to split by speaker,
 * since OpenRouter ASR models never return speaker labels themselves.
 */
export async function transcribeWithOpenRouter(file, audioBuffer, { language } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  const preparedAudio = await prepareAudioForAsr(file, audioBuffer);

  return withAsrRetries(
    async () => {
      const responseBody = await callOpenRouterAsr({
        apiKey,
        audioBuffer: preparedAudio.buffer,
        format: preparedAudio.format,
        language,
      });

      return {
        text: responseBody?.text || '',
        usage: responseBody?.usage || null,
        compressed: preparedAudio.compressed,
        language: language || responseBody?.language || null,
      };
    },
    () => `Audio payload: ${Math.round(preparedAudio.buffer.length / 1024 / 1024)} MB ${preparedAudio.compressed ? '(compressed)' : '(original)'}`,
  );
}

/**
 * ASR transcription with segment-level timestamps, via the same endpoint but
 * requesting `verbose_json` + `timestamp_granularities`. Per OpenRouter's STT
 * docs, real timestamps are only returned when the request lands on an
 * OpenAI-compatible backing provider (OpenAI/Groq/Together) - if a response
 * comes back without a `segments` array, callers should treat it as a failed
 * chunk rather than trust untimed text. Used by the accuracy pipeline
 * (pipelineDiarizer.js) on pre-chunked, pre-normalized audio - no size-based
 * compression here, callers are expected to hand it small-enough chunks.
 */
export async function transcribeChunkWithTimestamps(buffer, format, { model, granularities, language } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !buffer) {
    return null;
  }

  return withAsrRetries(
    async () => {
      const responseBody = await callOpenRouterAsr({
        apiKey,
        audioBuffer: buffer,
        format,
        model,
        language,
        responseFormat: 'verbose_json',
        timestampGranularities: granularities || ['segment'],
      });

      return {
        text: responseBody?.text || '',
        segments: Array.isArray(responseBody?.segments) ? responseBody.segments : [],
        words: Array.isArray(responseBody?.words) ? responseBody.words : [],
        language: responseBody?.language || null,
        duration: responseBody?.duration || null,
      };
    },
    () => `Chunk payload: ${Math.round(buffer.length / 1024 / 1024)} MB`,
  );
}
