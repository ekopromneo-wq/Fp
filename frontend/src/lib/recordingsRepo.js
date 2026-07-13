import {
  putCachedRecording,
  putCachedRecordings,
  getCachedRecordings,
  getCachedRecording,
  putCachedProjects,
  getCachedProjects,
} from './offlineDb.js';

// Browsers reject fetch() with a TypeError specifically for network-level
// failures (offline, DNS, connection refused) - a response that came back
// with a non-2xx status is a *different*, unrelated Error thrown further up
// in App.jsx's own `if (!response.ok) throw new Error(...)` checks. This is
// what lets the offline fallback trigger only for "no network", not for
// ordinary HTTP errors like a failed auth check.
export function isNetworkFailure(error) {
  return error instanceof TypeError;
}

export async function cacheRecordingsList(recordings) {
  await putCachedRecordings(recordings);
}

export async function cacheRecordingDetail(recording) {
  await putCachedRecording(recording);
}

export async function offlineRecordingsList() {
  return getCachedRecordings();
}

export async function offlineRecordingDetail(id) {
  return getCachedRecording(id);
}

export async function cacheProjects(projects) {
  await putCachedProjects(projects);
}

export async function offlineProjects() {
  return getCachedProjects();
}
