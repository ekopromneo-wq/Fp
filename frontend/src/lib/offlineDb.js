import { openDB } from 'idb';
import { isWebCryptoAvailable, generateAudioKey, encryptBlob, decryptBlob } from './blobCrypto.js';

const DB_NAME = 'voxmate';
// v2: добавлен стор liveChunks для US-1.8 — чанки идущей записи сбрасываются
// в него по ходу дела, чтобы пережить разряд/крэш вкладки до нажатия «Стоп».
const DB_VERSION = 2;

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }

        // Not used until offline recording capture (Phase C) lands, but
        // declared now so that phase doesn't need its own DB version bump.
        if (!db.objectStoreNames.contains('writeQueue')) {
          const writeQueue = db.createObjectStore('writeQueue', { keyPath: 'localId' });
          writeQueue.createIndex('by-syncState', 'syncState');
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }

        // US-1.8: append-only чанки активной записи. Ключ autoIncrement сохраняет
        // порядок вставки, индекс by-session позволяет собрать/очистить одну сессию.
        if (!db.objectStoreNames.contains('liveChunks')) {
          const liveChunks = db.createObjectStore('liveChunks', { keyPath: 'seq', autoIncrement: true });
          liveChunks.createIndex('by-session', 'sessionId');
        }
      },
    });
  }

  return dbPromise;
}

// US-3.5: ключ шифрования аудио. Неэкспортируемый CryptoKey хранится в meta и
// переживает перезагрузки (structured clone сохраняет и материал, и флаг
// extractable=false). Создаётся один раз при первой необходимости. null —
// WebCrypto недоступен (очень старый браузер): тогда пишем без шифрования, чтобы
// не потерять офлайн-запись (доступность важнее для сценария «нет сети»).
let audioKeyPromise = null;

async function getAudioKey() {
  if (!isWebCryptoAvailable()) {
    return null;
  }

  if (!audioKeyPromise) {
    audioKeyPromise = (async () => {
      const db = await getDb();
      const existing = await db.get('meta', 'audioEncKey');

      if (existing?.value) {
        return existing.value;
      }

      const key = await generateAudioKey();
      await db.put('meta', { key: 'audioEncKey', value: key });
      return key;
    })().catch(() => null);
  }

  return audioKeyPromise;
}

export async function putCachedRecording(recording) {
  if (!recording?.id) {
    return;
  }

  const db = await getDb();
  const existing = await db.get('recordings', recording.id);
  // List responses are thinner than detail responses (no transcript/summary/
  // tasks/speakers) - merge rather than overwrite so a list refresh doesn't
  // clobber a previously-cached detail view of the same recording.
  await db.put('recordings', existing ? { ...existing, ...recording } : recording);
}

export async function putCachedRecordings(recordings) {
  await Promise.all((recordings || []).map((recording) => putCachedRecording(recording)));
}

export async function getCachedRecordings() {
  const db = await getDb();
  return db.getAll('recordings');
}

export async function getCachedRecording(id) {
  if (!id) {
    return null;
  }

  const db = await getDb();
  return (await db.get('recordings', id)) || null;
}

export async function putCachedProjects(projects) {
  const db = await getDb();
  const tx = db.transaction('projects', 'readwrite');
  await Promise.all((projects || []).map((project) => tx.store.put(project)));
  await tx.done;
}

export async function getCachedProjects() {
  const db = await getDb();
  return db.getAll('projects');
}

export async function putCachedCurrentUser(user) {
  const db = await getDb();
  await db.put('meta', { key: 'currentUser', value: user });
}

export async function getCachedCurrentUser() {
  const db = await getDb();
  const row = await db.get('meta', 'currentUser');
  return row?.value || null;
}

export async function putQueueItem(item) {
  const db = await getDb();
  await db.put('writeQueue', await encryptQueueItem(item));
}

// US-3.5: шифруем аудио-блоб очереди перед записью в IndexedDB. Метаданные
// (title/filename/размер) остаются как есть — шифруется именно запись (аудио).
async function encryptQueueItem(item) {
  const key = await getAudioKey();

  if (key && item.blob instanceof Blob) {
    const enc = await encryptBlob(key, item.blob);
    return { ...item, blob: enc, blobEncrypted: true };
  }

  return item;
}

// Расшифровка аудио элемента очереди — вызывается синхронизатором прямо перед
// выгрузкой (а не на каждом чтении списка), чтобы не разворачивать аудио в память
// ради рендера метаданных. Возвращает Blob или null, если недоступно.
export async function getDecryptedQueueBlob(item) {
  if (!item?.blobEncrypted) {
    return item?.blob || null;
  }

  const key = await getAudioKey();

  if (!key) {
    return null;
  }

  return decryptBlob(key, item.blob, item.mimeType);
}

export async function updateQueueItem(localId, patch) {
  const db = await getDb();
  const existing = await db.get('writeQueue', localId);

  if (!existing) {
    return null;
  }

  const updated = { ...existing, ...patch };
  await db.put('writeQueue', updated);
  return updated;
}

export async function getQueueItem(localId) {
  const db = await getDb();
  return (await db.get('writeQueue', localId)) || null;
}

export async function getAllQueueItems() {
  const db = await getDb();
  return db.getAll('writeQueue');
}

export async function deleteQueueItem(localId) {
  const db = await getDb();
  await db.delete('writeQueue', localId);
}

export async function clearOfflineCache() {
  const db = await getDb();
  await Promise.all(
    ['recordings', 'projects', 'writeQueue', 'meta', 'liveChunks'].map((storeName) => db.clear(storeName)),
  );
}

// --- US-1.8: живая запись, устойчивая к разряду/крэшу ------------------------

// Открывает новую сессию записи: сносит остатки прошлых сессий (страховка от
// незакрытой аварийной) и запоминает метаданные для последующей сборки файла.
export async function startLiveRecordingSession(session) {
  if (!session?.sessionId) {
    return;
  }

  const db = await getDb();
  await db.clear('liveChunks');
  await db.put('meta', { key: 'activeRecording', value: session });
}

// Дописывает один чанк идущей записи. Fire-and-forget из ondataavailable —
// потеря одного чанка не должна ронять саму запись, поэтому без throw наружу.
export async function appendLiveRecordingChunk(sessionId, blob) {
  if (!sessionId || !blob?.size) {
    return;
  }

  const db = await getDb();
  const key = await getAudioKey();

  if (key) {
    // US-3.5: чанки идущей записи тоже шифруем на устройстве.
    await db.add('liveChunks', { sessionId, enc: await encryptBlob(key, blob), encrypted: true });
  } else {
    await db.add('liveChunks', { sessionId, blob });
  }
}

export async function getActiveRecordingSession() {
  const db = await getDb();
  const row = await db.get('meta', 'activeRecording');
  return row?.value || null;
}

export async function getLiveRecordingChunks(sessionId) {
  const db = await getDb();
  const rows = await db.getAllFromIndex('liveChunks', 'by-session', sessionId);
  const key = await getAudioKey();
  const blobs = [];

  for (const row of rows) {
    if (row.encrypted && row.enc) {
      // Ключ должен быть — чанки писались с ним; если недоступен, пропускаем.
      // eslint-disable-next-line no-await-in-loop
      if (key) blobs.push(await decryptBlob(key, row.enc));
    } else if (row.blob) {
      blobs.push(row.blob);
    }
  }

  return blobs;
}

// Закрывает сессию: удаляет дескриптор и все её чанки. Вызывается и после
// нормального «Стоп» (файл уже в очереди отправки), и после восстановления.
export async function clearLiveRecordingSession() {
  const db = await getDb();
  await db.delete('meta', 'activeRecording');
  await db.clear('liveChunks');
}
