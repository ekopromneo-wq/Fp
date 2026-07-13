import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFfprobeDurationSeconds } from './ffmpeg.js';

export const MAX_UPLOAD_DURATION_SECONDS = Number(process.env.MAX_UPLOAD_DURATION_SECONDS || 4 * 60 * 60);

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

    let durationSeconds;
    try {
      durationSeconds = await getFfprobeDurationSeconds(inputPath);
    } catch (error) {
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
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
