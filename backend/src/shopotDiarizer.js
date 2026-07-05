const SHOPOT_API_URL = process.env.SHOPOT_API_URL || 'https://api.shopot.ai';
const SHOPOT_POLL_INTERVAL_MS = Number(process.env.SHOPOT_POLL_INTERVAL_MS || 5000);
const SHOPOT_POLL_TIMEOUT_MS = Number(process.env.SHOPOT_POLL_TIMEOUT_MS || 30 * 60 * 1000);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatShopotSpeakerLabel(label) {
  const raw = String(label ?? '').trim();
  const match = raw.match(/speaker_?(\d+)/i) || raw.match(/^(\d+)$/);

  return match ? `Спикер ${Number(match[1]) + 1}` : raw || 'Спикер 1';
}

function mergeShopotSegments(segments) {
  const merged = [];

  for (const segment of segments) {
    const speaker = formatShopotSpeakerLabel(segment.speaker);
    const last = merged[merged.length - 1];

    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${segment.text}`.trim();
      last.endMs = Math.round(Number(segment.end || 0) * 1000);
    } else {
      merged.push({
        speaker,
        text: segment.text,
        startMs: Math.round(Number(segment.start || 0) * 1000),
        endMs: Math.round(Number(segment.end || 0) * 1000),
      });
    }
  }

  return merged;
}

async function submitShopotJob(file, audioBuffer, apiKey) {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([audioBuffer], { type: file?.mime_type || 'application/octet-stream' }),
    file?.original_filename || 'audio',
  );
  formData.append('language', process.env.SHOPOT_LANGUAGE || 'ru');
  formData.append('disable_diarization', 'false');

  const response = await fetch(`${SHOPOT_API_URL}/v1/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error || body?.message || `Shopot transcribe request failed with ${response.status}`);
  }

  if (!body?.id) {
    throw new Error('Shopot transcribe response is missing a task id');
  }

  return body.id;
}

async function pollShopotJob(taskId, apiKey) {
  const deadline = Date.now() + SHOPOT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(`${SHOPOT_API_URL}/v1/status/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.error || body?.message || `Shopot status check failed with ${response.status}`);
    }

    const status = body?.transcription_status;

    if (status === 'FAILED') {
      throw new Error(`Shopot transcription failed for task ${taskId}`);
    }

    if (status === 'TRANSCRIBED' || status === 'COMPLETED') {
      return body;
    }

    await sleep(SHOPOT_POLL_INTERVAL_MS);
  }

  throw new Error(`Shopot transcription timed out after ${SHOPOT_POLL_TIMEOUT_MS}ms for task ${taskId}`);
}

/**
 * Diarizes a recording via the Shopot API (api.shopot.ai) instead of the
 * local WhisperX/pyannote service. Returns null (instead of throwing) when
 * the key isn't configured or the call fails, so callers fall back to the
 * plain OpenRouter ASR + text-based speaker split.
 */
async function transcribeWithShopot(file, audioBuffer, config = {}) {
  const apiKey = config.shopotApiKey || process.env.SHOPOT_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  try {
    const taskId = await submitShopotJob(file, audioBuffer, apiKey);
    console.log(`Submitted Shopot transcription task ${taskId}`);

    const result = await pollShopotJob(taskId, apiKey);
    const rawSegments = Array.isArray(result?.output?.list)
      ? result.output.list.filter((segment) => segment.text?.trim())
      : [];

    if (!rawSegments.length) {
      return null;
    }

    const segments = mergeShopotSegments(rawSegments);

    return {
      text: segments.map((segment) => `${segment.speaker}\n${segment.text}`).join('\n\n'),
      segments,
      speakerCount: new Set(segments.map((segment) => segment.speaker)).size,
    };
  } catch (error) {
    console.warn('Shopot transcription failed, falling back to OpenRouter ASR:', error.message);
    return null;
  }
}

export { transcribeWithShopot };
