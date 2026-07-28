import { randomUUID } from 'node:crypto';

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

    // Zoom uses many datacenter subdomains (us04web.zoom.us, us05web.zoom.us, ...)
    // plus org vanity subdomains, so it needs a suffix check rather than an
    // exact-hostname entry in SELF_HOSTED_PLATFORM_HOSTS.
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
      return 'zoom';
    }

    return SELF_HOSTED_PLATFORM_HOSTS[host] || null;
  } catch {
    return null;
  }
}

const JOIN_RETRY_DELAY_MS = 3000;

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestRecorderJob(input, correlationId) {
  const response = await fetch(`${RECORDER_BOT_URL}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': RECORDER_BOT_INTERNAL_SECRET,
      // STG-001: одна и та же попытка присоединения ищется по этому ID и в
      // логах backend (botLog), и в логах recorder-bot - без этого сопоставить
      // «пользователь увидел ошибку в 14:32» с конкретной строкой в другом
      // контейнере можно было только по времени, вручную.
      'X-Correlation-Id': correlationId,
    },
    body: JSON.stringify({
      recordingId: input.recordingId,
      meetingUrl: input.meetingUrl,
      title: input.title,
      platform: input.platform,
      botName: input.botName || 'Stenogram',
    }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    // recorder-bot отвечает {error: ...} (server.js) — раньше здесь читали
    // body?.message, которого там нет, и всегда падали в generic-фоллбэк:
    // реальная причина 409 терялась. statusCode вешаем на Error, чтобы дошёл
    // до structured join_failed в botLog.
    const error = new Error(body?.error || body?.message || `Recorder-bot join failed with ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  if (!body?.jobId) {
    throw new Error('Recorder-bot join response is missing a job id');
  }

  return body;
}

/**
 * Asks the self-hosted recorder-bot service to join a live meeting and
 * capture audio itself (no third party ever sees the call). The bot reports
 * back to our own /api/internal/recorder-bot/callback route with the
 * finished audio file once the meeting ends.
 *
 * STG-001: 409 значит «этот recorder-bot инстанс занят другой встречей» -
 * повтор тут не поможет (слот освободится не раньше конца ЧУЖОЙ встречи), это
 * не временный сбой, а реальная нехватка ёмкости. Ретраим только настоящие
 * временные сбои - сетевые/5xx от самого recorder-bot (упавший Playwright,
 * контейнер перезапускается и т.п.) - один раз, через несколько секунд.
 */
export async function startRecorderJob(input, correlationId = randomUUID()) {
  try {
    const result = await requestRecorderJob(input, correlationId);
    return { ...result, correlationId };
  } catch (error) {
    const isConflict = error.statusCode === 409;
    const isRetryable = !isConflict && (!error.statusCode || error.statusCode >= 500);

    if (!isRetryable) {
      error.correlationId = correlationId;
      throw error;
    }

    console.warn(`[${correlationId}] recorder-bot join failed (${error.statusCode || 'network'}), retrying once: ${error.message}`);
    await delay(JOIN_RETRY_DELAY_MS);

    try {
      const result = await requestRecorderJob(input, correlationId);
      return { ...result, correlationId };
    } catch (retryError) {
      retryError.correlationId = correlationId;
      throw retryError;
    }
  }
}

export async function stopRecorderJob(jobId) {
  const response = await fetch(`${RECORDER_BOT_URL}/jobs/${jobId}/stop`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': RECORDER_BOT_INTERNAL_SECRET },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `Recorder-bot stop failed with ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return body;
}
