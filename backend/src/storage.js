import { createReadStream } from 'node:fs';
import { Client } from 'minio';

const endpointUrl = new URL(process.env.S3_ENDPOINT || 'http://localhost:9000');

export const audioBucket = process.env.S3_BUCKET || 'voxmate-audio';

export const storageClient = new Client({
  endPoint: endpointUrl.hostname,
  port: Number(endpointUrl.port || (endpointUrl.protocol === 'https:' ? 443 : 80)),
  useSSL: endpointUrl.protocol === 'https:',
  accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
});

export async function ensureAudioBucket() {
  const exists = await storageClient.bucketExists(audioBucket);

  if (!exists) {
    await storageClient.makeBucket(audioBucket);
    console.log(`Created MinIO bucket ${audioBucket}`);
  }
}

// body — Buffer или Readable-стрим; size обязателен (minio требует длину и для
// стрима). Стрим позволяет заливать большие файлы (до 1 ГБ) без материализации
// всего файла в памяти.
async function putAudioObject(recordingId, body, size, originalFilename, mimeType) {
  const extension = originalFilename.includes('.') ? originalFilename.split('.').pop() : 'bin';
  const storageKey = `recordings/${recordingId}/audio-${Date.now()}.${extension}`;

  await storageClient.putObject(audioBucket, storageKey, body, size, {
    'Content-Type': mimeType,
    // HTTP headers (including S3 user metadata) must be ASCII - non-Latin
    // filenames (e.g. Cyrillic) would otherwise throw ERR_INVALID_CHAR here.
    // Nothing in this codebase reads this metadata back (the DB's
    // original_filename column, not S3 metadata, is the source of truth),
    // so it's safe to just percent-encode it.
    'X-Amz-Meta-Original-Filename': encodeURIComponent(originalFilename),
  });

  return {
    storageKey,
    originalFilename,
    mimeType,
    fileSizeBytes: size,
  };
}

export async function saveRecordingAudio(recordingId, file, buffer) {
  const originalFilename = file.name || 'audio';
  const resolvedBuffer = buffer || Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  return putAudioObject(recordingId, resolvedBuffer, resolvedBuffer.length, originalFilename, mimeType);
}

/**
 * Заливает аудио в MinIO ПОТОКОМ прямо с диска (staging-файл чанковой загрузки),
 * не читая весь файл в память. Память — O(chunk) вместо O(file), что и позволяет
 * держать лимит 1 ГБ на небольшом сервере (см. §6.6).
 */
export async function saveRecordingAudioFromPath(recordingId, filePath, { originalFilename, mimeType, fileSizeBytes }) {
  return putAudioObject(
    recordingId,
    createReadStream(filePath),
    fileSizeBytes,
    originalFilename || 'audio',
    mimeType || 'application/octet-stream',
  );
}

/**
 * Swaps a recording's stored audio object for a different buffer (used to
 * replace an uploaded video with just its extracted audio track once
 * processed - see videoAudio.js), deleting the previous object afterward.
 */
export async function replaceRecordingAudio(recordingId, previousStorageKey, buffer, originalFilename, mimeType) {
  const metadata = await putAudioObject(recordingId, buffer, originalFilename, mimeType);

  if (previousStorageKey) {
    await deleteRecordingAudio(previousStorageKey).catch((error) => {
      console.error(`Failed to delete replaced audio object ${previousStorageKey}`, error);
    });
  }

  return metadata;
}

export async function deleteRecordingAudio(storageKey) {
  if (!storageKey) {
    return;
  }

  await storageClient.removeObject(audioBucket, storageKey);
}

export async function getRecordingAudioStream(storageKey) {
  if (!storageKey) {
    return null;
  }

  return storageClient.getObject(audioBucket, storageKey);
}

// Needed for the audio player's speed/seek controls (US-6.2) - without
// range support, scrubbing to a later point in a large recording means the
// browser has already buffered (or is still waiting on) everything before
// it, which is slow and wasteful for multi-hour files.
export async function getRecordingAudioRange(storageKey, offset, length) {
  if (!storageKey) {
    return null;
  }

  return storageClient.getPartialObject(audioBucket, storageKey, offset, length);
}

export async function getRecordingAudioBuffer(storageKey) {
  const stream = await getRecordingAudioStream(storageKey);

  if (!stream) {
    return null;
  }

  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
