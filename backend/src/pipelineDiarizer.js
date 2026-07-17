import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAudioFormat, getFfprobeDurationSeconds, runFfmpeg } from './ffmpeg.js';
import { parseJsonObject } from './llmJson.js';
import { transcribeChunkWithTimestamps } from './openrouterAsr.js';
import { trySplitTranscriptBySpeaker } from './speakerSplit.js';

// Chunking only applies to the Whisper step (see step 2) - the voice
// diarization step (step 4) still sees the whole recording in one call, so
// its S1/S2/S3 labels are already globally consistent and don't need
// cross-chunk reconciliation.
//
// Было: разметка по голосу видела весь файл одним запросом и на длинной записи
// накрывала лишь начало — на 71-минутном совещании 66 минут «наговорил» один
// спикер. Теперь голос тоже режется на перекрывающиеся окна (см.
// splitOverlappingChunks), каждое размечается отдельно, а метисы сшиваются по
// зоне перекрытия (stitchChunkIntervals): кто говорит в одни и те же моменты на
// стыке — тот же человек. Покрытие всё равно проверяется (voiceCoverage): если
// после сшивки накрыто меньше MIN_VOICE_COVERAGE — уходим на текстовую разметку.
const CHUNK_SECONDS = Number(process.env.PIPELINE_CHUNK_SECONDS || 480);
// Окно разметки по голосу и перехлёст между соседними окнами (для сшивки).
// Записи короче одного окна размечаются одним запросом — сшивать нечего.
const VOICE_CHUNK_SECONDS = Number(process.env.PIPELINE_VOICE_CHUNK_SECONDS || 600);
const VOICE_OVERLAP_SECONDS = Number(process.env.PIPELINE_VOICE_OVERLAP_SECONDS || 60);
const MIN_VOICE_COVERAGE = Number(process.env.PIPELINE_MIN_VOICE_COVERAGE || 0.6);
// Дальше этого расстояния сегмент считается лежащим вне размеченной области:
// «ближайший» интервал в минутах от него ничего не говорит о том, кто говорит.
const MAX_GAP_TO_NEAREST_MS = Number(process.env.PIPELINE_MAX_GAP_TO_NEAREST_MS || 30000);
// Подпись для участков, которые разметка по голосу не накрыла. Честнее выдумать
// её, чем приписать слова случайному участнику.
const UNKNOWN_SPEAKER_LABEL = 'Спикер ?';
const WHISPER_MODEL = process.env.PIPELINE_WHISPER_MODEL || 'openai/whisper-large-v3';
const VOICE_MODEL = process.env.PIPELINE_VOICE_MODEL || 'google/gemini-2.5-pro';
const IDENTITY_MODEL = process.env.PIPELINE_IDENTITY_MODEL || 'anthropic/claude-sonnet-5';
const WHISPER_CONCURRENCY = Number(process.env.PIPELINE_WHISPER_CONCURRENCY || 3);

const VOICE_SYSTEM_PROMPT =
  'Ты помощник, который слушает аудиозапись встречи и определяет, кто и когда говорит - только по голосу, ' +
  'без расшифровки слов. Прослушай запись целиком и раздели её на интервалы по говорящим. Один и тот же голос ' +
  'всегда подписывай одинаковой меткой (S1, S2, S3, ...) на протяжении всей записи, даже если он долго молчал. ' +
  'Не заводи новую метку без явной уверенности, что это действительно другой голос, а не тот же человек с иной ' +
  'интонацией, громкостью или фоновым шумом - при сомнении переиспользуй уже существующую метку. Реальные встречи ' +
  'почти всегда ведут разумное число участников, обычно заметно меньше 15 - если у тебя получается счёт на десятки ' +
  'меток, это почти наверняка ошибочное переразбиение одних и тех же голосов, а не отдельные люди; в таком случае ' +
  'пересмотри разметку и объедини близкие по звучанию кластеры. ' +
  'Текст реплик передавать не нужно - только границы по времени. ' +
  'Верни строго JSON без markdown в формате {"intervals":[{"speaker":"S1","start":number,"end":number}]}, ' +
  'где start/end - время в секундах от начала записи.';

const IDENTITY_SYSTEM_PROMPT =
  'Тебе дают стенограмму встречи, уже размеченную по голосовым кластерам (S1, S2, ...) с таймкодами и точным текстом. ' +
  'Определи реальное имя и/или роль каждого кластера по содержанию: самопредставление, обращения друг к другу по имени, ' +
  'упоминания в третьем лице, характерная для роли лексика. Для каждого кластера укажи уровень уверенности: ' +
  '"high" (прямое самопредставление или многократное обращение по имени), "medium" (косвенные признаки), ' +
  '"low" (нет надёжных признаков). Обязательно приведи короткую цитату-доказательство (evidence) из текста для ' +
  'high/medium. Если уверенности нет, верни name: null. ' +
  'Верни строго JSON без markdown в формате ' +
  '{"speakers":{"S1":{"name":"string|null","confidence":"high|medium|low","evidence":"string"}}}.';

async function normalizeAudio(workdir, file, audioBuffer) {
  const inputFormat = getAudioFormat(file);
  const inputPath = path.join(workdir, `input.${inputFormat || 'audio'}`);
  const normalizedPath = path.join(workdir, 'normalized.mp3');

  await writeFile(inputPath, audioBuffer);
  await runFfmpeg(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', normalizedPath]);

  return normalizedPath;
}

/**
 * Cuts the normalized recording into fixed-length chunks for the Whisper
 * step only (see module-level comment). `-ss` before `-i` plus `-t` for
 * clip length is the standard accurate-seek idiom; mp3 has no keyframe/GOP
 * concerns like video, so `-c copy` cuts cleanly at arbitrary times.
 */
async function splitIntoChunks(workdir, normalizedPath) {
  const durationSeconds = await getFfprobeDurationSeconds(normalizedPath);
  const chunkCount = Math.max(1, Math.ceil(durationSeconds / CHUNK_SECONDS));
  const chunks = [];

  for (let i = 0; i < chunkCount; i += 1) {
    const startSeconds = i * CHUNK_SECONDS;
    const clipSeconds = Math.min(CHUNK_SECONDS, durationSeconds - startSeconds);
    const chunkPath = path.join(workdir, `chunk-${i}.mp3`);

    await runFfmpeg([
      '-y',
      '-ss',
      String(startSeconds),
      '-i',
      normalizedPath,
      '-t',
      String(clipSeconds),
      '-c',
      'copy',
      chunkPath,
    ]);

    chunks.push({
      buffer: await readFile(chunkPath),
      offsetMs: Math.round(startSeconds * 1000),
    });
  }

  return chunks;
}

function batchArray(items, size) {
  const batches = [];

  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }

  return batches;
}

/**
 * Transcribes each chunk with real segment timestamps, in bounded-concurrency
 * batches, then flattens into one absolute-timestamp segment list for the
 * whole recording (chunk offset added back in). A chunk that comes back
 * without a `segments` array (see transcribeChunkWithTimestamps' doc comment
 * on provider routing) is logged and skipped rather than trusted untimed.
 */
async function runWhisperOnChunks(chunks, language) {
  const allSegments = [];

  for (const batch of batchArray(chunks, WHISPER_CONCURRENCY)) {
    const results = await Promise.all(
      batch.map((chunk) =>
        transcribeChunkWithTimestamps(chunk.buffer, 'mp3', { model: WHISPER_MODEL, granularities: ['segment'], language }).catch(
          (error) => {
            console.warn(`Pipeline: Whisper chunk at offset ${chunk.offsetMs}ms failed:`, error.message);
            return null;
          },
        ),
      ),
    );

    results.forEach((result, index) => {
      const chunk = batch[index];

      if (!result || !result.segments.length) {
        console.warn(`Pipeline: Whisper chunk at offset ${chunk.offsetMs}ms returned no timestamped segments`);
        return;
      }

      for (const segment of result.segments) {
        const text = String(segment.text || '').trim();

        if (!text) continue;

        allSegments.push({
          text,
          startMs: chunk.offsetMs + Math.round(Number(segment.start || 0) * 1000),
          endMs: chunk.offsetMs + Math.round(Number(segment.end || 0) * 1000),
        });
      }
    });
  }

  return allSegments.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The voice-interval response schema is speaker labels + numbers only (no
 * free-form prose) - unlike the shared parseJsonObject's other callers
 * (which do carry natural-language text, where this would risk mangling a
 * real apostrophe), it's safe here to retry with single quotes normalized
 * to double quotes if strict parsing fails. Gemini occasionally emits
 * JS-object-literal-style single-quoted strings despite `response_format`.
 */
function parseIntervalsJson(content) {
  try {
    return parseJsonObject(content);
  } catch (error) {
    try {
      return parseJsonObject(content.replace(/'/g, '"'));
    } catch {
      throw error;
    }
  }
}

/**
 * Режет нормализованную дорожку на перекрывающиеся окна для разметки по голосу.
 * Перехлёст нужен сшивке: в нём соседние окна размечают одних и тех же людей,
 * и по их совпадению во времени метки склеиваются в сквозные.
 */
async function splitOverlappingChunks(workdir, normalizedPath) {
  const durationSeconds = await getFfprobeDurationSeconds(normalizedPath);

  if (durationSeconds <= VOICE_CHUNK_SECONDS) {
    return [{ buffer: await readFile(normalizedPath), offsetMs: 0 }];
  }

  const step = VOICE_CHUNK_SECONDS - VOICE_OVERLAP_SECONDS;
  const chunks = [];

  for (let start = 0, i = 0; start < durationSeconds; start += step, i += 1) {
    const clip = Math.min(VOICE_CHUNK_SECONDS, durationSeconds - start);
    const chunkPath = path.join(workdir, `voice-${i}.mp3`);
    await runFfmpeg(['-y', '-ss', String(start), '-i', normalizedPath, '-t', String(clip), '-c', 'copy', chunkPath]);
    chunks.push({ buffer: await readFile(chunkPath), offsetMs: Math.round(start * 1000) });

    if (start + clip >= durationSeconds) {
      break;
    }
  }

  return chunks;
}

// Суммарное перекрытие двух наборов интервалов во времени — «сколько эти два
// голоса говорили одновременно» в зоне стыка.
function overlapMs(aIntervals, bIntervals) {
  let total = 0;
  for (const a of aIntervals) {
    for (const b of bIntervals) {
      total += Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
    }
  }
  return total;
}

/**
 * Сшивает пометки соседних окон в сквозные (S1 второго окна — не обязательно S1
 * первого). Для каждого окна, кроме первого, каждую его локальную метку
 * сопоставляем с уже накопленной сквозной меткой по максимальному совпадению во
 * времени в зоне перехлёста; не нашли — заводим новую. Чистая функция ради
 * тестируемости: на вход — интервалы каждого окна с локальными метками и
 * абсолютным временем.
 */
export function stitchChunkIntervals(chunkList) {
  // Накопленные сквозные интервалы (по глобальным меткам) и их индекс по метке.
  const globalByLabel = new Map();
  let nextGlobal = 1;

  const pushGlobal = (label, list) => {
    if (!globalByLabel.has(label)) {
      globalByLabel.set(label, []);
    }
    globalByLabel.get(label).push(...list);
  };

  chunkList.forEach((chunk, index) => {
    // Локальные метки окна → их интервалы.
    const localGroups = new Map();
    for (const interval of chunk) {
      if (!localGroups.has(interval.speaker)) {
        localGroups.set(interval.speaker, []);
      }
      localGroups.get(interval.speaker).push(interval);
    }

    if (index === 0) {
      for (const [label, list] of localGroups) {
        const global = `S${nextGlobal++}`;
        pushGlobal(global, list.map((item) => ({ startMs: item.startMs, endMs: item.endMs })));
      }
      return;
    }

    // Зона перехлёста с уже накопленным: от начала окна до максимума
    // накопленных интервалов.
    const chunkStart = Math.min(...chunk.map((interval) => interval.startMs));

    for (const [localLabel, list] of localGroups) {
      const inOverlap = list.filter((interval) => interval.startMs < chunkStart + VOICE_OVERLAP_SECONDS * 1000);
      let bestGlobal = null;
      let bestOverlap = 0;

      for (const [global, globalIntervals] of globalByLabel) {
        const score = overlapMs(inOverlap, globalIntervals);
        if (score > bestOverlap) {
          bestOverlap = score;
          bestGlobal = global;
        }
      }

      const target = bestOverlap > 0 ? bestGlobal : `S${nextGlobal++}`;
      // В итог добавляем только часть за пределами перехлёста, чтобы не
      // задвоить общую с прошлым окном речь.
      const beyondOverlap = list
        .filter((interval) => interval.endMs > chunkStart + VOICE_OVERLAP_SECONDS * 1000)
        .map((item) => ({ startMs: item.startMs, endMs: item.endMs }));
      pushGlobal(target, beyondOverlap);
    }
  });

  const merged = [];
  for (const [label, list] of globalByLabel) {
    for (const interval of list) {
      merged.push({ speaker: label, startMs: interval.startMs, endMs: interval.endMs });
    }
  }

  return merged.filter((interval) => interval.endMs > interval.startMs).sort((a, b) => a.startMs - b.startMs);
}

async function requestVoiceIntervals(normalizedBuffer, apiKey, model, offsetMs = 0) {
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
        { role: 'system', content: VOICE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Определи интервалы речи по говорящим в этой записи.' },
            { type: 'input_audio', input_audio: { data: normalizedBuffer.toString('base64'), format: 'mp3' } },
          ],
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Voice diarization request failed with ${response.status}`);
  }

  const parsed = parseIntervalsJson(body?.choices?.[0]?.message?.content);
  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.intervals) ? parsed.intervals : [];
  // Времена в ответе — от начала окна; offsetMs переводит в абсолютные.
  const intervals = rawList
    .map((interval) => ({
      speaker: String(interval?.speaker || '').trim() || 'S1',
      startMs: offsetMs + Math.round(Number(interval?.start || 0) * 1000),
      endMs: offsetMs + Math.round(Number(interval?.end || 0) * 1000),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  return intervals;
}

async function requestVoiceIntervalsWithRetry(buffer, apiKey, model, offsetMs) {
  try {
    return await requestVoiceIntervals(buffer, apiKey, model, offsetMs);
  } catch (error) {
    console.warn(`Pipeline: voice diarization window at ${Math.round(offsetMs / 1000)}s failed (${error.message}), retrying once`);
    return requestVoiceIntervals(buffer, apiKey, model, offsetMs);
  }
}

/**
 * Разметка по голосу всей записи: режем на перекрывающиеся окна, размечаем
 * каждое и сшиваем метки в сквозные (см. stitchChunkIntervals). Провал одного
 * окна не рушит остальные. Короткая запись — одно окно без сшивки.
 */
async function runVoiceDiarization(workdir, normalizedPath, apiKey, model) {
  const chunks = await splitOverlappingChunks(workdir, normalizedPath);
  const perChunk = [];

  for (const chunk of chunks) {
    try {
      const intervals = await requestVoiceIntervalsWithRetry(chunk.buffer, apiKey, model, chunk.offsetMs);
      if (intervals.length) {
        perChunk.push(intervals);
      }
    } catch (error) {
      console.warn(`Pipeline: voice window at ${Math.round(chunk.offsetMs / 1000)}s gave nothing: ${error.message}`);
    }
  }

  if (!perChunk.length) {
    throw new Error('Voice diarization returned no usable intervals');
  }

  const stitched = chunks.length > 1 ? stitchChunkIntervals(perChunk) : perChunk[0];
  console.log(`Pipeline: voice diarization ${chunks.length} window(s) → ${new Set(stitched.map((i) => i.speaker)).size} speaker(s)`);
  return stitched;
}

function nearestInterval(segment, voiceIntervals) {
  const midpointMs = (segment.startMs + segment.endMs) / 2;
  let best = null;
  let bestDistanceMs = Infinity;

  for (const interval of voiceIntervals) {
    // Расстояние до интервала, а не до его середины: длинный интервал рядом
    // ближе короткого вдалеке, даже если середина у него дальше.
    const distanceMs = Math.max(0, interval.startMs - midpointMs, midpointMs - interval.endMs);

    if (distanceMs < bestDistanceMs) {
      bestDistanceMs = distanceMs;
      best = interval;
    }
  }

  return { interval: best, distanceMs: bestDistanceMs };
}

/**
 * Доля речи, которую разметка по голосу реально накрыла интервалами. Считаем по
 * времени Whisper-сегментов, а не по длине записи: паузы, музыка и тишина в
 * знаменателе только маскировали бы провал.
 */
function voiceCoverage(whisperSegments, voiceIntervals) {
  let speechMs = 0;
  let coveredMs = 0;

  for (const segment of whisperSegments) {
    const durationMs = Math.max(0, segment.endMs - segment.startMs);
    speechMs += durationMs;

    let overlapMs = 0;

    for (const interval of voiceIntervals) {
      overlapMs += Math.max(0, Math.min(segment.endMs, interval.endMs) - Math.max(segment.startMs, interval.startMs));
    }

    coveredMs += Math.min(durationMs, overlapMs);
  }

  return speechMs > 0 ? coveredMs / speechMs : 0;
}

/**
 * Assigns each precisely-timed Whisper segment to whichever voice interval
 * it overlaps most. Segments falling in a small gap between intervals fall
 * back to the nearest interval, so short pauses don't drop a turn. Сегменты
 * дальше MAX_GAP_TO_NEAREST_MS от любого интервала помечаются как неразмеченные
 * (speaker: null): раньше их отдавали ближайшему интервалу, и вся неразмеченная
 * часть записи молча приписывалась одному человеку.
 */
function assignSpeakersToSegments(whisperSegments, voiceIntervals) {
  return whisperSegments.map((segment) => {
    let bestInterval = null;
    let bestOverlapMs = 0;

    for (const interval of voiceIntervals) {
      const overlapMs = Math.min(segment.endMs, interval.endMs) - Math.max(segment.startMs, interval.startMs);

      if (overlapMs > bestOverlapMs) {
        bestOverlapMs = overlapMs;
        bestInterval = interval;
      }
    }

    if (!bestInterval) {
      const { interval, distanceMs } = nearestInterval(segment, voiceIntervals);
      bestInterval = distanceMs <= MAX_GAP_TO_NEAREST_MS ? interval : null;
    }

    return {
      speaker: bestInterval?.speaker || null,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    };
  });
}

function mergeAdjacentSameSpeaker(segments) {
  const merged = [];

  for (const segment of segments) {
    const last = merged[merged.length - 1];

    if (last && last.speaker === segment.speaker) {
      last.text = `${last.text} ${segment.text}`.trim();
      last.endMs = segment.endMs;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

function formatTimestamp(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

async function requestSpeakerIdentities(segments, apiKey, model) {
  // Неразмеченные куски имени не несут: кластера у них нет, а в стенограмме для
  // модели они выглядели бы как ещё один участник по имени «null».
  const transcript = segments
    .filter((segment) => segment.speaker)
    .map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.speaker}: ${segment.text}`)
    .join('\n');

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
      // Same rationale as speakerSplit.js: keep this fast/JSON-focused rather
      // than burning tokens on hidden chain-of-thought.
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: IDENTITY_SYSTEM_PROMPT },
        { role: 'user', content: `Определи говорящих в этой стенограмме:\n\n${transcript}` },
      ],
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Speaker identity request failed with ${response.status}`);
  }

  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content);

  return parsed?.speakers && typeof parsed.speakers === 'object' ? parsed.speakers : {};
}

/**
 * Segments always stay on a stable positional "Спикер N" label, regardless
 * of identity confidence - a guessed name is a *suggestion* for the user to
 * accept/reject (US-7.1), not something to silently bake into the
 * transcript before anyone has seen it. Any cluster the LLM offered a name
 * for (any confidence level, including low - the user decides the bar, not
 * this function) is returned separately in `identities`, keyed by the same
 * stable label the segments carry, for the caller to persist as a pending
 * suggestion.
 */
function resolveSpeakerLabels(segments, identities) {
  const clusterOrder = [];

  for (const segment of segments) {
    // Неразмеченные куски (speaker: null) не заводят собственного «спикера»:
    // это не человек, а признание, что участок не размечен.
    if (segment.speaker && !clusterOrder.includes(segment.speaker)) {
      clusterOrder.push(segment.speaker);
    }
  }

  const labelByCluster = new Map();
  const identitiesByLabel = {};

  clusterOrder.forEach((cluster, index) => {
    const label = `Спикер ${index + 1}`;
    labelByCluster.set(cluster, label);

    const identity = identities[cluster];

    if (identity?.name) {
      identitiesByLabel[label] = {
        suggestedName: String(identity.name).trim(),
        confidence: identity.confidence || null,
        evidence: identity.evidence || null,
      };
    }
  });

  const relabeledSegments = segments.map((segment) => ({
    ...segment,
    speaker: segment.speaker ? labelByCluster.get(segment.speaker) || segment.speaker : UNKNOWN_SPEAKER_LABEL,
  }));

  return { segments: relabeledSegments, identities: identitiesByLabel };
}

function formatFinalOutput(segments) {
  const text = segments
    .map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.speaker}: ${segment.text}`)
    .join('\n\n');

  return {
    text,
    segments,
    // «Спикер ?» — это не участник встречи, а неразмеченный участок: в счёт
    // говорящих он не идёт.
    speakerCount: new Set(segments.map((segment) => segment.speaker)).size - (segments.some((s) => s.speaker === UNKNOWN_SPEAKER_LABEL) ? 1 : 0),
  };
}

/**
 * Разметка по голосу не удалась, но расшифровка Whisper на руках — размечаем
 * спикеров по тексту, а не выбрасываем работу: воркеровский запасной путь всё
 * равно сделал бы то же самое, только сначала прогнал бы ASR по всей записи
 * заново. Таймкоды при этом теряются: текстовая разметка не знает о времени.
 */
async function textSplitFallback(whisperSegments, config) {
  const text = whisperSegments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ');
  const split = await trySplitTranscriptBySpeaker(text);

  if (!split) {
    return null;
  }

  console.log(`Pipeline: text-based speaker split produced ${split.speakerCount} speaker(s)`);

  return { ...split, language: config.language || null, identities: {} };
}

/**
 * Accuracy-focused diarization pipeline: Whisper (chunked, real timestamps)
 * for text, Gemini (whole file) for coarse voice-based speaker turns, merged
 * by timestamp overlap, then Claude resolves the voice clusters to real
 * names with confidence + evidence. Returns null (instead of throwing) on
 * any failure, matching the other diarizers' contract, so worker.js's
 * existing OpenRouter + text-based speakerSplit fallback takes over.
 */
export async function transcribeWithAccuratePipeline(file, audioBuffer, config = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || !audioBuffer) {
    return null;
  }

  const workdir = path.join(tmpdir(), `voxmate-pipeline-${randomUUID()}`);
  await mkdir(workdir, { recursive: true });

  try {
    const normalizedPath = await normalizeAudio(workdir, file, audioBuffer);
    const chunks = await splitIntoChunks(workdir, normalizedPath);

    console.log(`Pipeline: split recording into ${chunks.length} chunk(s) of up to ${CHUNK_SECONDS}s for Whisper`);

    const [whisperSegments, voiceIntervals] = await Promise.all([
      runWhisperOnChunks(chunks, config.language),
      runVoiceDiarization(workdir, normalizedPath, apiKey, VOICE_MODEL),
    ]);

    console.log(
      `Pipeline: Whisper produced ${whisperSegments.length} timed segment(s), voice diarization produced ${voiceIntervals.length} interval(s)`,
    );

    if (!whisperSegments.length || !voiceIntervals.length) {
      console.warn('Pipeline: missing Whisper segments or voice intervals, aborting');
      return null;
    }

    // Диагностика: до какой минуты вообще дотянулась разметка по голосу и какую
    // долю речи она накрыла. Без этих двух чисел негодная разметка выглядела
    // ровно как удачная.
    const speechEndMs = Math.max(...whisperSegments.map((segment) => segment.endMs));
    const intervalsEndMs = Math.max(...voiceIntervals.map((interval) => interval.endMs));
    const coverage = voiceCoverage(whisperSegments, voiceIntervals);

    console.log(
      `Pipeline: voice intervals span ${(Math.min(...voiceIntervals.map((i) => i.startMs)) / 60000).toFixed(1)}-${(
        intervalsEndMs / 60000
      ).toFixed(1)} min of a ${(speechEndMs / 60000).toFixed(1)} min recording and cover ${(coverage * 100).toFixed(1)}% of transcribed speech`,
    );

    if (coverage < MIN_VOICE_COVERAGE) {
      console.warn(
        `Pipeline: voice diarization covered only ${(coverage * 100).toFixed(1)}% of speech (need ${(
          MIN_VOICE_COVERAGE * 100
        ).toFixed(0)}%) - слишком мало, чтобы доверять; размечаем спикеров по тексту расшифровки`,
      );

      return textSplitFallback(whisperSegments, config);
    }

    const merged = mergeAdjacentSameSpeaker(assignSpeakersToSegments(whisperSegments, voiceIntervals));

    let identities = {};

    try {
      identities = await requestSpeakerIdentities(merged, apiKey, IDENTITY_MODEL);
    } catch (error) {
      console.warn('Pipeline: speaker identity resolution failed, keeping generic labels:', error.message);
    }

    const { segments: labeledSegments, identities: resolvedIdentities } = resolveSpeakerLabels(merged, identities);
    const finalSegments = mergeAdjacentSameSpeaker(labeledSegments);

    console.log(
      `Pipeline: resolved ${finalSegments.length} final turn(s) across ${new Set(finalSegments.map((s) => s.speaker)).size} speaker(s)`,
    );

    return { ...formatFinalOutput(finalSegments), language: config.language || null, identities: resolvedIdentities };
  } catch (error) {
    console.warn('Accuracy pipeline diarization failed, falling back:', error.message);
    return null;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
