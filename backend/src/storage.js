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

export async function saveRecordingAudio(recordingId, file) {
  const originalFilename = file.name || 'audio';
  const extension = originalFilename.includes('.') ? originalFilename.split('.').pop() : 'bin';
  const storageKey = `recordings/${recordingId}/audio-${Date.now()}.${extension}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  await storageClient.putObject(audioBucket, storageKey, buffer, buffer.length, {
    'Content-Type': mimeType,
    'X-Amz-Meta-Original-Filename': originalFilename,
  });

  return {
    storageKey,
    originalFilename,
    mimeType,
    fileSizeBytes: buffer.length,
  };
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
