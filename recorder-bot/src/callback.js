import { readFile, unlink } from 'node:fs/promises';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL || 'http://api:4000';
const RECORDER_BOT_INTERNAL_SECRET = process.env.RECORDER_BOT_INTERNAL_SECRET || '';

export async function sendCallback({ recordingId, filePath, errorMessage }) {
  const formData = new FormData();
  formData.set('recordingId', recordingId);

  if (errorMessage) {
    formData.set('error', errorMessage);
  }

  if (filePath) {
    const buffer = await readFile(filePath);
    formData.set('file', new Blob([buffer], { type: 'audio/wav' }), `${recordingId}.wav`);
  }

  const response = await fetch(`${API_INTERNAL_URL}/api/internal/recorder-bot/callback`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': RECORDER_BOT_INTERNAL_SECRET },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Callback failed with ${response.status}: ${body}`);
  }

  if (filePath) {
    await unlink(filePath).catch(() => {});
  }
}
