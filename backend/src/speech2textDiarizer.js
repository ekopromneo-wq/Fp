export const SPEECH2TEXT_API_URL = process.env.SPEECH2TEXT_API_URL || 'https://api.speech2text.ru';
const SPEECH2TEXT_POLL_INTERVAL_MS = Number(process.env.SPEECH2TEXT_POLL_INTERVAL_MS || 5000);
const SPEECH2TEXT_POLL_TIMEOUT_MS = Number(process.env.SPEECH2TEXT_POLL_TIMEOUT_MS || 30 * 60 * 1000);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeSpeech2TextSegments(segments) {
  const merged = [];

  for (const segment of segments) {
    const speaker = segment.speaker;
    const last = merged[merged.length - 1];

    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${segment.text}`.trim();
      last.endMs = Math.round(Number(segment.end || 0) * 1000);
    } else {
      merged.push({
        speaker,
        text: String(segment.text || '').trim(),
        startMs: Math.round(Number(segment.start || 0) * 1000),
        endMs: Math.round(Number(segment.end || 0) * 1000),
      });
    }
  }

  return merged;
}

async function submitSpeech2TextJob(file, audioBuffer, apiKey) {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([audioBuffer], { type: file?.mime_type || 'application/octet-stream' }),
    file?.original_filename || 'audio',
  );
  formData.append('lang', process.env.SPEECH2TEXT_LANGUAGE || 'ru');

  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/recognitions/task/file?api-key=${apiKey}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: formData,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Speech2Text task submission failed with ${response.status}`);
  }

  if (!body?.id) {
    throw new Error('Speech2Text response is missing a task id');
  }

  return body.id;
}

async function pollSpeech2TextJob(taskId, apiKey) {
  const deadline = Date.now() + SPEECH2TEXT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${SPEECH2TEXT_API_URL}/api/recognitions/${taskId}?api-key=${apiKey}`);
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.message || `Speech2Text status check failed with ${response.status}`);
    }

    const statusCode = body?.status?.code;

    if (statusCode === 501) {
      throw new Error(`Speech2Text recognition failed for task ${taskId}: ${body?.status?.description || 'unknown error'}`);
    }

    if (statusCode === 200) {
      return body;
    }

    await sleep(SPEECH2TEXT_POLL_INTERVAL_MS);
  }

  throw new Error(`Speech2Text transcription timed out after ${SPEECH2TEXT_POLL_TIMEOUT_MS}ms for task ${taskId}`);
}

export async function fetchSpeech2TextResult(taskId, apiKey) {
  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/recognitions/${taskId}/result/json?api-key=${apiKey}`);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Speech2Text result fetch failed with ${response.status}`);
  }

  return body;
}

/**
 * Checks a Speech2Text task's status without blocking/looping - a single
 * GET. Used both by the file-based polling loop below and by the meeting-bot
 * poller in worker.js, which drives its own polling cadence across many
 * concurrent recordings.
 */
export async function checkSpeech2TextStatus(taskId, apiKey) {
  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/recognitions/${taskId}?api-key=${apiKey}`);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.message || `Speech2Text status check failed with ${response.status}`);
  }

  return body;
}

/**
 * Converts a completed Speech2Text /result/json payload (chunks + speakers)
 * into VoxMate's internal transcript shape. Returns null when there's no
 * usable speech (e.g. status 204 - "no speech detected").
 */
export function parseSpeech2TextResult(result) {
  const speakerNames = new Map((result?.speakers || []).map((speaker) => [speaker.id, speaker.name]));
  const rawChunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const rawSegments = rawChunks
    .filter((chunk) => chunk.text?.trim())
    .map((chunk) => ({
      speaker: speakerNames.get(chunk.speaker) || `Спикер ${Number(chunk.speaker) + 1}`,
      start: chunk.time?.from,
      end: chunk.time?.to,
      text: chunk.text,
    }));

  if (!rawSegments.length) {
    return null;
  }

  const segments = mergeSpeech2TextSegments(rawSegments);

  return {
    text: segments.map((segment) => `${segment.speaker}\n${segment.text}`).join('\n\n'),
    segments,
    speakerCount: new Set(segments.map((segment) => segment.speaker)).size,
  };
}

/**
 * Diarizes a recording via the Speech2Text API (speech2text.ru). Unlike
 * Shopot/Gemini this service only assigns generic SPEAKER_N labels - no name
 * identification - but it also exposes speaker voice vectors (unused here).
 * Returns null (instead of throwing) on any failure, so callers fall back to
 * the plain OpenRouter ASR + text-based speaker split.
 */
export async function transcribeWithSpeech2Text(file, audioBuffer, config = {}) {
  const apiKey = config.speech2textApiKey || process.env.SPEECH2TEXT_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  try {
    const taskId = await submitSpeech2TextJob(file, audioBuffer, apiKey);
    console.log(`Submitted Speech2Text task ${taskId}`);

    await pollSpeech2TextJob(taskId, apiKey);
    const result = await fetchSpeech2TextResult(taskId, apiKey);

    return parseSpeech2TextResult(result);
  } catch (error) {
    console.warn('Speech2Text transcription failed, falling back:', error.message);
    return null;
  }
}
