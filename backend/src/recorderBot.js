const RECORDER_BOT_URL = process.env.RECORDER_BOT_URL || 'http://recorder-bot:8100';
const RECORDER_BOT_INTERNAL_SECRET = process.env.RECORDER_BOT_INTERNAL_SECRET || '';

const SELF_HOSTED_PLATFORM_HOSTS = {
  'telemost.360.yandex.ru': 'telemost',
  'telemost.yandex.ru': 'telemost',
};

export function isSupportedMeetingUrl(meetingUrl) {
  return Boolean(detectPlatform(meetingUrl));
}

export function detectPlatform(meetingUrl) {
  try {
    const host = new URL(meetingUrl).hostname.replace(/^www\./, '');
    return SELF_HOSTED_PLATFORM_HOSTS[host] || null;
  } catch {
    return null;
  }
}

/**
 * Asks the self-hosted recorder-bot service to join a live meeting and
 * capture audio itself (no third party ever sees the call). The bot reports
 * back to our own /api/internal/recorder-bot/callback route with the
 * finished audio file once the meeting ends.
 */
export async function startRecorderJob(input) {
  const response = await fetch(`${RECORDER_BOT_URL}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': RECORDER_BOT_INTERNAL_SECRET,
    },
    body: JSON.stringify({
      recordingId: input.recordingId,
      meetingUrl: input.meetingUrl,
      title: input.title,
      platform: input.platform,
      botName: input.botName || 'VoxMate',
    }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Recorder-bot join failed with ${response.status}`);
  }

  if (!body?.jobId) {
    throw new Error('Recorder-bot join response is missing a job id');
  }

  return body;
}

export async function stopRecorderJob(jobId) {
  const response = await fetch(`${RECORDER_BOT_URL}/jobs/${jobId}/stop`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': RECORDER_BOT_INTERNAL_SECRET },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Recorder-bot stop failed with ${response.status}`);
  }

  return body;
}
