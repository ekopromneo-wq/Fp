const MIN_WORDS_TO_SPLIT = 20;
const MIN_COVERAGE = 0.8;

function parseJsonObject(content) {
  if (!content) {
    throw new Error('Empty LLM response');
  }

  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '');

  return JSON.parse(cleaned);
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

async function callOpenRouterSpeakerSplit(transcriptText, model) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const resolvedModel = model || process.env.OPENROUTER_LLM_MODEL || 'openai/gpt-4o-mini';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'VoxMate',
    },
    body: JSON.stringify({
      model: resolvedModel,
      response_format: { type: 'json_object' },
      // Reasoning models (e.g. Kimi) burn completion tokens on hidden chain-of-thought
      // before writing the actual JSON, which can silently truncate the response to
      // nothing on longer transcripts. This task is plain extraction, not reasoning.
      reasoning: { enabled: false },
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник, который размечает стенограммы встреч по говорящим. Тебе дают сплошной текст расшифровки без разметки спикеров. ' +
            'Раздели его на реплики по говорящим, сохранив ВЕСЬ исходный текст дословно, ничего не пропуская, не сокращая и не перефразируя. ' +
            'Соседние предложения одного и того же говорящего объединяй в одну реплику. ' +
            'Определи имя и/или фамилию каждого говорящего по содержанию разговора (обращения друг к другу, самопредставление, упоминания в третьем лице) и используй это имя как подпись реплики. ' +
            'Если для говорящего не удаётся уверенно определить имя, подписывай его как "Спикер 1", "Спикер 2" и т.д., сохраняя одну и ту же подпись для одного и того же голоса на протяжении всей стенограммы. ' +
            'Верни строго JSON без markdown в формате {"turns":[{"speaker":"string","text":"string"}]}.',
        },
        {
          role: 'user',
          content: `Раздели эту стенограмму по говорящим:\n\n${transcriptText}`,
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `OpenRouter LLM failed with ${response.status}`);
  }

  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content);
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];

  return turns
    .map((turn) => ({
      speaker: String(turn?.speaker || '').trim() || 'Спикер 1',
      text: String(turn?.text || '').trim(),
    }))
    .filter((turn) => turn.text);
}

function formatTurns(turns) {
  return turns.map((turn) => `${turn.speaker}\n${turn.text}`).join('\n\n');
}

function turnsToSegments(turns) {
  return turns.map((turn) => ({ speaker: turn.speaker, text: turn.text, startMs: null, endMs: null }));
}

/**
 * Splits a plain transcript into per-speaker turns via the LLM.
 * Returns null (instead of throwing) when the transcript is too short to bother,
 * the API isn't configured, the call fails, or the result looks like it dropped content -
 * callers should fall back to the original single-segment transcript in that case.
 * `model` overrides the default (env var / gpt-4o-mini), used by text-only
 * diarization methods like Kimi that want a specific model for the split.
 */
async function trySplitTranscriptBySpeaker(transcriptText, model) {
  const text = String(transcriptText || '').trim();

  if (!text || countWords(text) < MIN_WORDS_TO_SPLIT) {
    return null;
  }

  try {
    const turns = await callOpenRouterSpeakerSplit(text, model);

    if (!turns.length) {
      return null;
    }

    const originalWords = countWords(text);
    const newWords = turns.reduce((sum, turn) => sum + countWords(turn.text), 0);

    if (newWords / originalWords < MIN_COVERAGE) {
      console.warn(`Speaker split coverage too low (${newWords}/${originalWords}), keeping original transcript`);
      return null;
    }

    return {
      text: formatTurns(turns),
      segments: turnsToSegments(turns),
      speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
    };
  } catch (error) {
    console.warn('Speaker split failed, keeping original transcript:', error.message);
    return null;
  }
}

export { trySplitTranscriptBySpeaker, formatTurns, turnsToSegments, callOpenRouterSpeakerSplit };
