/**
 * Uploads a Blob to an already-created/resumed upload session, one chunk at
 * a time, starting at `startOffset`. Chunks are strictly sequential - this
 * only ever appends from wherever the server says it left off, matching the
 * backend's offset-validated append (see backend/src/uploadSessions.js).
 *
 * Throws on the first unrecoverable error (network failure, non-2xx/409
 * response) so the caller (syncEngine) can decide how to handle a paused
 * upload - this function itself has no retry/backoff of its own.
 */
export async function uploadBlobInChunks(apiFetch, recordingId, blob, { chunkSizeBytes, startOffset = 0, onChunkUploaded }) {
  let offset = startOffset;

  while (offset < blob.size) {
    const chunk = blob.slice(offset, Math.min(offset + chunkSizeBytes, blob.size));
    const buffer = await chunk.arrayBuffer();

    const response = await apiFetch(`/api/recordings/${recordingId}/upload-session/chunk?offset=${offset}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });

    if (response.status === 409) {
      const data = await response.json().catch(() => null);

      if (typeof data?.expectedOffset !== 'number') {
        throw new Error('Сервер сообщил о несовпадении смещения без корректного значения.');
      }

      // Client and server disagree on progress (e.g. a previous attempt was
      // interrupted after the server persisted a chunk but before the client
      // heard back) - resync to the server's real offset and keep going,
      // rather than treating this as a fatal error.
      offset = data.expectedOffset;

      if (onChunkUploaded) {
        await onChunkUploaded(offset);
      }

      continue;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || 'Не удалось загрузить часть файла');
    }

    const data = await response.json();
    offset = data.bytesReceived;

    if (onChunkUploaded) {
      await onChunkUploaded(offset);
    }
  }

  return offset;
}
