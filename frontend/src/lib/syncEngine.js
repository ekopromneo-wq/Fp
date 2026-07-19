import { putQueueItem, updateQueueItem, deleteQueueItem, getAllQueueItems } from './offlineDb.js';
import { uploadBlobInChunks } from './chunkedUploader.js';

let isProcessing = false;

function generateLocalId() {
  return `local-${crypto.randomUUID()}`;
}

// US-3.4: мобильная сеть определяется по Network Information API. Надёжного
// сигнала «это сотовая сеть» в вебе нет: type='cellular' отдают не все
// браузеры, поэтому дополнительно считаем метку saveData («экономия трафика»)
// признаком, что выгрузку лучше придержать. Если API недоступен — не блокируем.
export function isMeteredConnection() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  if (!connection) {
    return false;
  }

  return connection.type === 'cellular' || Boolean(connection.saveData);
}

/**
 * Shapes a writeQueue row into something RecordingCard/App.jsx can render
 * exactly like a real recording - id: localId means every existing
 * `.find(r => r.id === x)` / `.map(...)` call site in App.jsx keeps working
 * unchanged while the recording only exists locally. `status` is left blank
 * deliberately: the backend's real status enum doesn't have a value for
 * "hasn't even been created server-side yet", and overloading it would
 * collide with the real thing once synced - syncState carries all the
 * signal for an in-flight item instead (see RecordingCard's sync pill).
 */
export function toSyntheticRecording(item) {
  return {
    id: item.localId,
    title: item.title,
    originalFilename: item.filename,
    fileSizeBytes: item.totalBytes,
    createdAt: item.createdAt,
    status: '',
    source: item.source,
    project: null,
    syncState: item.syncState,
    syncProgress: item.totalBytes ? item.bytesAcked / item.totalBytes : 0,
    syncError: item.lastError || null,
  };
}

export async function enqueueRecording(file, title, source) {
  const item = {
    localId: generateLocalId(),
    title: title || file.name,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    source,
    blob: file,
    totalBytes: file.size,
    bytesAcked: 0,
    chunkSizeBytes: null,
    serverRecordingId: null,
    syncState: 'local-pending',
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    lastAttemptAt: null,
  };

  await putQueueItem(item);
  return item;
}

export async function getQueueSnapshot() {
  return getAllQueueItems();
}

async function syncOneItem(apiFetch, item, callbacks) {
  try {
    await updateQueueItem(item.localId, { syncState: 'syncing', lastAttemptAt: new Date().toISOString() });
    callbacks.onItemChange?.(item.localId, { syncState: 'syncing' });

    let serverRecordingId = item.serverRecordingId;

    if (!serverRecordingId) {
      const createResponse = await apiFetch('/api/recordings', {
        method: 'POST',
        body: JSON.stringify({ title: item.title, source: item.source }),
      });

      if (!createResponse.ok) {
        throw new Error('Не удалось создать запись на сервере');
      }

      const createData = await createResponse.json();
      serverRecordingId = createData.recording.id;
      await updateQueueItem(item.localId, { serverRecordingId });
    }

    const sessionResponse = await apiFetch(`/api/recordings/${serverRecordingId}/upload-session`, {
      method: 'POST',
      body: JSON.stringify({
        originalFilename: item.filename,
        mimeType: item.mimeType,
        totalSizeBytes: item.totalBytes,
      }),
    });

    if (!sessionResponse.ok) {
      throw new Error('Не удалось начать сессию загрузки');
    }

    const { session } = await sessionResponse.json();
    // The server is the source of truth for how much it actually has - a
    // client that crashed/reloaded mid-upload trusts this over its own
    // last-remembered bytesAcked.
    await updateQueueItem(item.localId, { bytesAcked: session.bytesReceived, chunkSizeBytes: session.chunkSizeBytes });
    callbacks.onItemChange?.(item.localId, { bytesAcked: session.bytesReceived });

    await uploadBlobInChunks(apiFetch, serverRecordingId, item.blob, {
      chunkSizeBytes: session.chunkSizeBytes,
      startOffset: session.bytesReceived,
      onChunkUploaded: async (bytesAcked) => {
        await updateQueueItem(item.localId, { bytesAcked });
        callbacks.onItemChange?.(item.localId, { bytesAcked });
      },
    });

    const completeResponse = await apiFetch(`/api/recordings/${serverRecordingId}/upload-session/complete`, {
      method: 'POST',
    });

    if (!completeResponse.ok) {
      const data = await completeResponse.json().catch(() => null);
      throw new Error(data?.error || 'Не удалось завершить загрузку');
    }

    const { recording } = await completeResponse.json();
    await deleteQueueItem(item.localId);
    callbacks.onSynced?.(item.localId, recording);
  } catch (error) {
    const updated = await updateQueueItem(item.localId, {
      syncState: 'sync-failed',
      lastError: error.message || 'Ошибка синхронизации',
      attempts: (item.attempts || 0) + 1,
    });
    callbacks.onFailed?.(item.localId, updated);
  }
}

/**
 * Drains the whole queue sequentially (one recording at a time - there's
 * nothing to gain from parallel uploads against a single connection, and it
 * keeps the offset-based chunk protocol simple). Safe to call repeatedly
 * (e.g. on every 'online' event, on mount, and after a manual "sync now"
 * click) - a concurrent call is a no-op, and a previously-failed item is
 * retried automatically just by being included in the next run.
 */
export async function processQueue(apiFetch, callbacks = {}, options = {}) {
  if (isProcessing || !navigator.onLine) {
    return;
  }

  // US-3.4: авто-синхронизация уважает запрет выгрузки по мобильной сети;
  // ручной запуск передаёт force=true и заливает несмотря на сеть.
  if (!options.force && options.blockMobileUpload && isMeteredConnection()) {
    callbacks.onMeteredSkip?.();
    return;
  }

  isProcessing = true;

  try {
    const items = await getAllQueueItems();

    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
      await syncOneItem(apiFetch, item, callbacks);
    }
  } finally {
    isProcessing = false;
  }
}
