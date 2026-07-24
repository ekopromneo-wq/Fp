import { mkdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { query } from './db.js';
import { attachRecordingAudioFromPath, enqueueRecording } from './recordings.js';
import { getRecordingAudioStream, deleteRecordingAudio } from './storage.js';
import { concatAudioFiles } from './ffmpeg.js';
import { MAX_UPLOAD_BYTES } from './uploadValidation.js';

// US-1.5: пока встреча в этих статусах, воркер читает её аудио — дозаписывать
// нельзя (иначе гонка). Дозапись разрешена из uploaded/done/failed.
const IN_FLIGHT_STATUSES = new Set(['queued', 'processing', 'transcribing', 'summarizing']);

const STAGING_DIR = process.env.UPLOAD_STAGING_DIR || path.join(process.cwd(), 'data', 'upload-staging');
const DEFAULT_CHUNK_SIZE_BYTES = Number(process.env.UPLOAD_CHUNK_SIZE_BYTES || 5 * 1024 * 1024);
const STALE_SESSION_MS = 48 * 60 * 60 * 1000;

export class UploadSessionError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'UploadSessionError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function mapSession(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    totalSizeBytes: Number(row.total_size_bytes),
    chunkSizeBytes: row.chunk_size_bytes,
    bytesReceived: Number(row.bytes_received),
    status: row.status,
  };
}

async function ensureStagingDir() {
  await mkdir(STAGING_DIR, { recursive: true });
}

// US-2.2: SHA-256 файла потоком (без чтения всего в память) — основа поиска
// дублей загрузки.
async function hashFilePath(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function findSessionRow(recordingId) {
  const result = await query('select * from upload_sessions where recording_id = $1', [recordingId]);
  return result.rows[0] || null;
}

async function assertOwnedRecording(recordingId, ownerId) {
  const result = await query('select id from recordings where id = $1 and owner_id = $2', [
    recordingId,
    ownerId,
  ]);

  return result.rowCount > 0;
}

async function deleteSessionRow(session) {
  await rm(session.staging_path, { force: true }).catch(() => {});
  await query('delete from upload_sessions where id = $1', [session.id]).catch(() => {});
}

/**
 * Create-or-resume, keyed purely by recording_id (not by device/session) -
 * whichever device asks "what have you got for this recording" gets the true
 * server-side offset, which is what makes cross-device continuation (US-3.6)
 * work with no extra code.
 */
export async function createOrResumeUploadSession(recordingId, ownerId, { originalFilename, mimeType, totalSizeBytes }) {
  if (!(await assertOwnedRecording(recordingId, ownerId))) {
    return null;
  }

  // The direct multipart route enforces this via hono/body-limit; a chunked
  // session arrives 5 MB at a time, so the declared total is the only place
  // the whole-file cap can be applied - without it a client could stage an
  // arbitrarily large file onto the server disk.
  if (!(totalSizeBytes > 0) || totalSizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadSessionError('too_large', 'Файл слишком большой для загрузки.');
  }

  const existing = await findSessionRow(recordingId);

  if (existing && existing.status === 'uploading') {
    // The DB row survives an api-container rebuild, but a staging file that
    // is missing or shorter than bytes_received can't be appended to at the
    // recorded offset - resuming would silently produce a corrupt file that
    // still passes the bytes_received == total_size_bytes check on complete.
    // Start over instead.
    const fileSize = await stat(existing.staging_path).then((s) => s.size).catch(() => null);

    if (fileSize === Number(existing.bytes_received)) {
      return mapSession(existing);
    }

    await deleteSessionRow(existing);
  } else if (existing) {
    // Leftover 'failed' row from a previous attempt - start clean.
    await deleteSessionRow(existing);
  }

  await ensureStagingDir();
  const stagingPath = path.join(STAGING_DIR, recordingId);
  await writeFile(stagingPath, Buffer.alloc(0));

  const inserted = await query(
    `
      insert into upload_sessions
        (recording_id, owner_id, original_filename, mime_type, total_size_bytes, chunk_size_bytes, staging_path)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning *
    `,
    [recordingId, ownerId, originalFilename, mimeType, totalSizeBytes, DEFAULT_CHUNK_SIZE_BYTES, stagingPath],
  );

  return mapSession(inserted.rows[0]);
}

export async function getUploadSessionState(recordingId, ownerId) {
  if (!(await assertOwnedRecording(recordingId, ownerId))) {
    return null;
  }

  const session = await findSessionRow(recordingId);
  return session ? mapSession(session) : { exists: false };
}

/**
 * Chunks are strictly sequential - the client always uploads from
 * bytesReceived onward. A mismatched offset means the client and server
 * disagree (e.g. the client lost its local queue state after a crash), so it
 * 409s with the real offset instead of silently accepting a gap or overlap.
 */
export async function appendChunk(recordingId, ownerId, offset, chunkBuffer) {
  if (!(await assertOwnedRecording(recordingId, ownerId))) {
    return null;
  }

  const session = await findSessionRow(recordingId);

  if (!session) {
    throw new UploadSessionError('no_session', 'Сессия загрузки не найдена — начните заново.');
  }

  if (session.status !== 'uploading') {
    throw new UploadSessionError('session_closed', 'Сессия загрузки уже завершена.');
  }

  const expectedOffset = Number(session.bytes_received);

  if (Number(offset) !== expectedOffset) {
    throw new UploadSessionError('offset_mismatch', 'Смещение не совпадает с состоянием на сервере.', { expectedOffset });
  }

  const bytesReceived = expectedOffset + chunkBuffer.length;

  if (bytesReceived > Number(session.total_size_bytes)) {
    throw new UploadSessionError('size_exceeded', 'Получено больше данных, чем заявленный размер файла.');
  }

  await appendFile(session.staging_path, chunkBuffer);

  await query('update upload_sessions set bytes_received = $1, updated_at = now() where id = $2', [
    bytesReceived,
    session.id,
  ]);

  return { bytesReceived, totalSizeBytes: Number(session.total_size_bytes) };
}

/**
 * Asserts the full byte range has arrived, then hands off to the existing,
 * unmodified attachRecordingAudio (probeUploadedAudio validation included) -
 * a chunked upload is just a different way of getting bytes onto disk before
 * that pipeline, not a different pipeline.
 */
export async function completeUploadSession(recordingId, ownerId) {
  if (!(await assertOwnedRecording(recordingId, ownerId))) {
    return null;
  }

  const session = await findSessionRow(recordingId);

  if (!session) {
    throw new UploadSessionError('no_session', 'Сессия загрузки не найдена.');
  }

  if (Number(session.bytes_received) !== Number(session.total_size_bytes)) {
    throw new UploadSessionError('incomplete', 'Не все части файла получены.', {
      bytesReceived: Number(session.bytes_received),
      totalSizeBytes: Number(session.total_size_bytes),
    });
  }

  // The DB counter and the file on disk can diverge (e.g. the staging file
  // was lost to a container rebuild mid-upload) - the counter alone isn't
  // proof the bytes are actually here.
  const fileSize = await stat(session.staging_path).then((s) => s.size).catch(() => null);

  if (fileSize !== Number(session.total_size_bytes)) {
    await deleteSessionRow(session);
    throw new UploadSessionError('no_session', 'Файл загрузки повреждён — начните заново.');
  }

  // Атомарно "застолбить" сессию за этим вызовом: без этого клиентский ретрай
  // на медленном ответе (ffmpeg-склейка + заливка в MinIO до 1 ГБ) может
  // пересечься со вторым одновременным completeUploadSession и обработать один
  // и тот же staging-файл дважды — двойная запись в usage_ledger от повторной
  // ASR, осиротевший объект в MinIO у проигравшего вызова.
  const claim = await query(
    `update upload_sessions set status = 'completed', updated_at = now() where id = $1 and status = 'uploading' returning id`,
    [session.id],
  );

  if (claim.rowCount === 0) {
    throw new UploadSessionError('already_completing', 'Загрузка уже обрабатывается.');
  }

  // US-1.5: если у встречи уже есть аудио — этот upload не заменяет его, а
  // дозаписывает фрагмент: скачиваем существующее аудио, склеиваем со свежим
  // куском через ffmpeg и пересобираем встречу в один файл (единый протокол).
  const existing = await query('select storage_key, status from recordings where id = $1', [recordingId]);
  const existingKey = existing.rows[0]?.storage_key || null;

  if (existingKey) {
    if (IN_FLIGHT_STATUSES.has(existing.rows[0].status)) {
      await deleteSessionRow(session);
      throw new UploadSessionError('busy', 'Встреча ещё обрабатывается — добавьте фрагмент после завершения.');
    }

    const existingPath = `${session.staging_path}.existing`;
    const combinedPath = `${session.staging_path}.combined.mp3`;

    try {
      const audioStream = await getRecordingAudioStream(existingKey);

      if (!audioStream) {
        throw new UploadSessionError('no_audio', 'Исходное аудио встречи недоступно.');
      }

      await pipeline(audioStream, createWriteStream(existingPath));
      await concatAudioFiles([existingPath, session.staging_path], combinedPath);
      const combinedSize = (await stat(combinedPath)).size;

      const recording = await attachRecordingAudioFromPath(
        recordingId,
        combinedPath,
        { originalFilename: 'combined-recording.mp3', mimeType: 'audio/mpeg', fileSizeBytes: combinedSize },
        ownerId,
      );

      // Прежний объект в MinIO осиротел (storage_key уже указывает на склейку).
      await deleteRecordingAudio(existingKey).catch((error) =>
        console.error(`Failed to delete pre-append audio ${existingKey}`, error),
      );
      // Пересобранную встречу гоним на полную (пере)расшифровку — старый
      // транскрипт/протокол больше не соответствует объединённому аудио.
      await enqueueRecording(recordingId, ownerId, { retranscribe: true });
      return recording;
    } finally {
      await rm(existingPath, { force: true }).catch(() => {});
      await rm(combinedPath, { force: true }).catch(() => {});
      await deleteSessionRow(session);
    }
  }

  try {
    // Стрим прямо со staging-файла (он уже целиком на диске) — без чтения всего
    // файла в память: ffprobe по пути + потоковая заливка в MinIO. Держит лимит
    // 1 ГБ на маленьком сервере (§6.6).
    const recording = await attachRecordingAudioFromPath(
      recordingId,
      session.staging_path,
      {
        originalFilename: session.original_filename,
        mimeType: session.mime_type,
        fileSizeBytes: Number(session.total_size_bytes),
      },
      ownerId,
    );

    // US-2.2: считаем хэш содержимого и ищем такой же файл у пользователя.
    // Загрузку не блокируем — просто сообщаем FE о дубле, чтобы пользователь сам
    // выбрал «оставить оба» или удалить лишнюю встречу.
    const contentHash = await hashFilePath(session.staging_path);
    const duplicate = await query(
      `select id, title from recordings
       where owner_id = $1 and content_hash = $2 and id <> $3 and deleted_at is null
       order by created_at asc limit 1`,
      [ownerId, contentHash, recordingId],
    );
    await query('update recordings set content_hash = $1 where id = $2', [contentHash, recordingId]);

    // The upload conveyor is meant to run end-to-end without a manual
    // "Запустить обработку" click (US-4.1/4.2) - the meeting-bot recording
    // path already auto-enqueues itself (see recordings.js), this is the
    // equivalent trigger for the mic/file-picker upload path.
    await enqueueRecording(recordingId, ownerId);

    if (duplicate.rowCount) {
      recording.duplicateOf = { id: duplicate.rows[0].id, title: duplicate.rows[0].title };
    }

    return recording;
  } finally {
    await deleteSessionRow(session);
  }
}

export async function cleanupStaleUploadSessions() {
  const cutoff = new Date(Date.now() - STALE_SESSION_MS);
  const stale = await query('select * from upload_sessions where updated_at < $1', [cutoff]);

  for (const session of stale.rows) {
    await rm(session.staging_path, { force: true }).catch(() => {});
  }

  if (stale.rowCount > 0) {
    await query('delete from upload_sessions where updated_at < $1', [cutoff]);
    console.log(`Cleaned up ${stale.rowCount} stale upload session(s)`);
  }
}
