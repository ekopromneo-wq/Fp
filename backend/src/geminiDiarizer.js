import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAudioFormat, runFfmpeg } from './ffmpeg.js';
import { parseJsonObject } from './llmJson.js';

const SYSTEM_PROMPT =
  'Ты помощник, который слушает аудиозапись встречи и размечает её по говорящим. ' +
  'Прослушай запись целиком. Раздели её на реплики по говорящим, сохранив ВЕСЬ произнесённый текст дословно. ' +
  'Соседние фразы одного и того же говорящего объединяй в одну реплику. ' +
  'Определи имя и/или фамилию каждого говорящего по содержанию разговора (самопредставление, обращения друг к другу, упоминания в третьем лице) и используй это имя как подпись реплики. ' +
  'Если для говорящего не удаётся уверенно определить имя, подписывай его как "Спикер 1", "Спикер 2" и т.д., сохраняя одну и ту же подпись для одного и того же голоса на протяжении всей записи, даже если он долго молчал. ' +
  'Верни строго JSON без markdown в формате {"segments":[{"speaker":"string","start":number,"end":number,"text":"string"}]}, где start/end — время реплики в секундах от начала записи.';

async function convertToMp3(file, audioBuffer) {
  const workdir = path.join(tmpdir(), `voxmate-gemini-${randomUUID()}`);
  const inputFormat = getAudioFormat(file);
  const inputPath = path.join(workdir, `input.${inputFormat || 'audio'}`);
  const outputPath = path.join(workdir, 'audio.mp3');

  await mkdir(workdir, { recursive: true });

  try {
    await writeFile(inputPath, audioBuffer);
    await runFfmpeg(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outputPath]);

    return await readFile(outputPath);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function mergeGeminiSegments(segments) {
  const merged = [];

  for (const segment of segments) {
    const speaker = String(segment.speaker || 'Спикер 1').trim() || 'Спикер 1';
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

/**
 * Diarizes and identifies speakers by name in one pass, using a natively
 * audio-understanding model (Gemini) over OpenRouter's chat completions
 * endpoint (input_audio content block) rather than the ASR-only
 * /audio/transcriptions endpoint, which never returns diarization for any
 * model. Returns null (instead of throwing) on any failure, so callers can
 * fall back to the plain OpenRouter ASR + text-based speaker split.
 */
async function requestGeminiSegments(mp3Buffer, apiKey, model) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'Stenogram',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Раздели эту аудиозапись встречи по спикерам и определи их имена.' },
            {
              type: 'input_audio',
              input_audio: { data: mp3Buffer.toString('base64'), format: 'mp3' },
            },
          ],
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Gemini audio request failed with ${response.status}`);
  }

  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content);
  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.segments) ? parsed.segments : [];
  const rawSegments = rawList.filter((segment) => segment.text?.trim());

  if (!rawSegments.length) {
    throw new Error('Gemini returned no usable segments');
  }

  return rawSegments;
}

export async function transcribeWithGeminiAudio(file, audioBuffer, config = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  const model = config.geminiModel || 'google/gemini-2.5-pro';

  try {
    const mp3Buffer = await convertToMp3(file, audioBuffer);
    let rawSegments;

    try {
      rawSegments = await requestGeminiSegments(mp3Buffer, apiKey, model);
    } catch (error) {
      console.warn(`Gemini audio request attempt 1 failed (${error.message}), retrying once`);
      rawSegments = await requestGeminiSegments(mp3Buffer, apiKey, model);
    }

    const segments = mergeGeminiSegments(rawSegments);

    return {
      text: segments.map((segment) => `${segment.speaker}\n${segment.text}`).join('\n\n'),
      segments,
      speakerCount: new Set(segments.map((segment) => segment.speaker)).size,
    };
  } catch (error) {
    console.warn('Gemini audio diarization failed, falling back:', error.message);
    return null;
  }
}
