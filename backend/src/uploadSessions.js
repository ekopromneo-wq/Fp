import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from './db.js';
import { attachRecordingAudio } from './recordings.js';

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

async function findSessionRow(recordingId) {
  const result = await query('select * from upload_sessions where recording_id = $1', [recordingId]);
  return result.rows[0] || null;
}

async function assertOwnedRecording(recordingId, ownerId) {
  const result = await query('select id from recordings where id = $1 and (owner_id = $2 or owner_id is null)', [
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

  const existing = await findSessionRow(recordingId);

  if (existing && existing.status === 'uploading') {
    return mapSession(existing);
  }

  if (existing) {
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

  await appendFile(session.staging_path, chunkBuffer);
  const bytesReceived = expectedOffset + chunkBuffer.length;

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

  const buffer = await readFile(session.staging_path);
  const fileLike = {
    arrayBuffer: async () => buffer,
    name: session.original_filename,
    type: session.mime_type,
  };

  try {
    return await attachRecordingAudio(recordingId, fileLike, ownerId);
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
