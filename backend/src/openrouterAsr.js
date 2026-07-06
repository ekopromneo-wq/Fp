import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

/**
 * Plain ASR transcription (no diarization) via OpenRouter's /audio/transcriptions
 * endpoint. Shared by worker.js (as the ultimate fallback) and text-based
 * diarization methods (like Kimi) that need a transcript to split by speaker,
 * since OpenRouter ASR models never return speaker labels themselves.
 */
export async function transcribeWithOpenRouter(file, audioBuffer) {
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
