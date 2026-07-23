import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFfprobeDurationSeconds } from './ffmpeg.js';

export const MAX_UPLOAD_DURATION_SECONDS = Number(process.env.MAX_UPLOAD_DURATION_SECONDS || 4 * 60 * 60);

// Matches the product spec's stated max upload size (1 GB); override via env
// if a deployment genuinely needs more. Shared by both upload paths - the
// direct multipart route (recordings.js) and the chunked session route
// (uploadSessions.js) - so neither can accept what the other would reject.
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);

export class UploadValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadValidationError';
    this.code = code;
  }
}

function getUploadExtension(originalFilename) {
  const name = originalFilename || '';
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  // ffprobe identifies containers by content, not extension, but it still
  // needs *a* file to read from disk - any reasonable placeholder works.
  return extension || 'bin';
}

/**
 * Validates an uploaded audio/video buffer before it's persisted: rejects
 * files ffprobe can't read at all (corrupt or genuinely unsupported), and
 * files longer than the configured duration cap. Returns the probed duration
 * so callers can persist it alongside the recording instead of leaving
 * `duration_seconds` unset.
 */
export async function probeUploadedAudio(buffer, originalFilename) {
  const workdir = path.join(tmpdir(), `voxmate-upload-${randomUUID()}`);
  const inputPath = path.join(workdir, `input.${getUploadExtension(originalFilename)}`);

  await mkdir(workdir, { recursive: true });

  try {
    await writeFile(inputPath, buffer);
    return await probeAudioAtPath(inputPath);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Ядро валидации: ffprobe уже лежащего на диске файла + проверка лимита
 * длительности. ffprobe определяет контейнер по содержимому, поэтому путь без
 * расширения (staging-файл чанковой загрузки) читается штатно.
 */
async function probeAudioAtPath(inputPath) {
  let durationSeconds;
  try {
    durationSeconds = await getFfprobeDurationSeconds(inputPath);
  } catch (error) {
    // Диагностика «повреждённых» загрузок: реальная причина ffprobe/ffmpeg в лог
    // + копия файла для вскрытия (только небольшие файлы — микрофонные записи).
    console.error(`Upload probe failed for ${inputPath}:`, error.message);
    try {
      const size = (await stat(inputPath)).size;
      if (size <= 50 * 1024 * 1024) {
        const rejectedDir = process.env.UPLOAD_STAGING_DIR || path.join(process.cwd(), 'data', 'upload-staging');
        await mkdir(rejectedDir, { recursive: true });
        const copyPath = path.join(rejectedDir, `rejected-${Date.now()}`);
        await copyFile(inputPath, copyPath);
        console.error(`Rejected upload saved for post-mortem: ${copyPath} (${size} bytes)`);
      }
    } catch {
      // Диагностика не должна менять поведение основного пути.
    }
    throw new UploadValidationError(
      'file_corrupt',
      'Файл повреждён или формат не поддерживается. Загрузите другой файл.',
    );
  }

  if (durationSeconds > MAX_UPLOAD_DURATION_SECONDS) {
    const maxHours = (MAX_UPLOAD_DURATION_SECONDS / 3600).toFixed(1).replace(/\.0$/, '');
    throw new UploadValidationError(
      'duration_exceeds_limit',
      `Запись длиннее ${maxHours} ч — максимальная поддерживаемая длительность.`,
    );
  }

  return { durationSeconds };
}

/**
 * Проба уже лежащего на диске файла (staging чанковой загрузки) — без чтения в
 * память и без временного файла. Используется в потоковом завершении загрузки.
 */
export async function probeUploadedAudioPath(inputPath) {
  return probeAudioAtPath(inputPath);
}
