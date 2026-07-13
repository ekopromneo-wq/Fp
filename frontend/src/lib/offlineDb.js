import { openDB } from 'idb';

const DB_NAME = 'voxmate';
const DB_VERSION = 1;

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
      },
    });
  }

  return dbPromise;
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

export async function clearOfflineCache() {
  const db = await getDb();
  await Promise.all(
    ['recordings', 'projects', 'writeQueue', 'meta'].map((storeName) => db.clear(storeName)),
  );
}
