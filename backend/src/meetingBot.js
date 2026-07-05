import { SPEECH2TEXT_API_URL } from './speech2textDiarizer.js';

const SUPPORTED_PLATFORM_HOSTS = [
  'zoom.us',
  'meet.google.com',
  'telemost.yandex.ru',
  'sferum.ru',
  'my.mts-link.ru',
  'bitrix24.ru',
  'bigbluebutton.ru',
  'kontur.ru',
];

export function isSupportedMeetingUrl(meetingUrl) {
  try {
    const host = new URL(meetingUrl).hostname.replace(/^www\./, '');
    return SUPPORTED_PLATFORM_HOSTS.some((supported) => host === supported || host.endsWith(`.${supported}`));
  } catch {
    return false;
  }
}

/**
 * Sends the Speech2Text bot to join a live meeting (Zoom, Google Meet,
 * Yandex Telemost, Bitrix24 video, etc). The bot records and transcribes on
 * their infrastructure; we only get back a task id to poll and, once done,
 * the same diarized transcript shape as file-based recognition. There's no
 * audio file to download - the recording stays text-only.
 */
export async function joinMeeting(input, apiKey) {
  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/meetings/join`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meeting_url: input.meetingUrl,
      title: input.title || undefined,
      lang: input.lang || process.env.SPEECH2TEXT_LANGUAGE || 'ru',
      speakers: input.speakers || undefined,
      bot_name: input.botName || 'VoxMate',
      access_code: input.accessCode || undefined,
    }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Speech2Text meeting join failed with ${response.status}`);
  }

  if (!body?.id) {
    throw new Error('Speech2Text meeting join response is missing a task id');
  }

  return body;
}

export async function stopMeeting(taskId, apiKey) {
  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/meetings/${taskId}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Speech2Text meeting stop failed with ${response.status}`);
  }

  return body;
}
