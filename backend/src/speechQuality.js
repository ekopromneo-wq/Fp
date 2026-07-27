// STG-002: раньше ЛЮБОЙ непустой транскрипт (в том числе типовая ASR-
// галлюцинация на тишине вроде «Продолжение следует...») безусловно уходил на
// генерацию протокола — модель добросовестно придумывала повестку, решения и
// задачи по мусорному тексту, и результат выглядел как настоящий протокол
// встречи. Это единственная композитная проверка "похоже ли это на реальную
// речь", вызываемая ДО суммаризации — и в файловом пайплайне (worker.js
// processRecording), и в приёме от Speech2Text (worker.js ingestCompletedMeeting).
// Не настоящий VAD (нет доступа к сырому аудио на этом уровне) — набор дешёвых
// текстовых эвристик, каждая покрывает свой класс мусора.

// Известные шаблоны ASR-галлюцинаций на тишине/шуме (Whisper и похожие модели
// заполняют паузы типовыми фразами из обучающих субтитров). Список
// пополняется по мере наблюдений в проде — намеренно статический массив в
// коде, а не таблица в БД (эпизодические правки, не нужен админ-интерфейс).
export const HALLUCINATION_BLOCKLIST = [
  'субтитры сделал dimatorzok',
  'продолжение следует',
  'redakteur:',
  'подписывайтесь на канал',
  'спасибо за просмотр',
  'до новых встреч',
  'ставьте лайк и подписывайтесь',
];

const MIN_WORD_COUNT = 8;
const MIN_CHAR_COUNT = 20;
const MIN_SPOKEN_MS = 3000;
const MIN_SPEECH_COVERAGE_RATIO = 0.02;
const REPETITION_MAX_UNIQUE_RATIO = 0.15;
const REPETITION_MIN_TOKENS_TO_CHECK = 20;

/**
 * @param {string} text - собранный текст стенограммы
 * @param {Array<{startMs?: number, endMs?: number, start_ms?: number, end_ms?: number}>} [segments]
 * @param {number|null} [durationMs] - длительность записи, если известна
 * @returns {{ ok: boolean, reason: string|null, detail: object }}
 */
export function assessSpeechQuality(text, segments, durationMs = null) {
  const normalized = String(text || '').trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { ok: false, reason: 'empty_transcript', detail: {} };
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT || normalized.length < MIN_CHAR_COUNT) {
    return { ok: false, reason: 'too_short', detail: { wordCount, charCount: normalized.length } };
  }

  for (const phrase of HALLUCINATION_BLOCKLIST) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: 'blocklist_match', detail: { phrase } };
    }
  }

  // Повтор: один и тот же короткий оборот много раз подряд — классический
  // паттерн ASR-галлюцинации на тишине. Меряем разнообразие 3-словных
  // шинглов, а не просто уникальность слов — в живой речи частые слова
  // («ну», «то есть») повторяются естественно и не должны триггерить это.
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= REPETITION_MIN_TOKENS_TO_CHECK) {
    const shingles = [];
    for (let i = 0; i + 2 < words.length; i += 1) {
      shingles.push(words.slice(i, i + 3).join(' ').toLowerCase());
    }
    const uniqueShingles = new Set(shingles).size;
    const uniqueRatio = shingles.length ? uniqueShingles / shingles.length : 1;
    if (uniqueRatio < REPETITION_MAX_UNIQUE_RATIO) {
      return { ok: false, reason: 'repetitive_pattern', detail: { uniqueRatio: Number(uniqueRatio.toFixed(3)) } };
    }
  }

  // Покрытие речью: суммарная длительность распознанных сегментов против
  // длительности записи (когда она известна — у Speech2Text её на момент
  // приёма нет, поэтому durationMs может быть null и этот блок молча
  // ограничивается только полом по абсолютной длительности).
  if (Array.isArray(segments) && segments.length) {
    const spokenMs = segments.reduce((sum, seg) => {
      const start = Number(seg?.startMs ?? seg?.start_ms ?? 0);
      const end = Number(seg?.endMs ?? seg?.end_ms ?? start);
      return sum + Math.max(0, end - start);
    }, 0);

    if (spokenMs < MIN_SPOKEN_MS) {
      return { ok: false, reason: 'insufficient_speech_duration', detail: { spokenMs } };
    }

    if (durationMs && durationMs > 0) {
      const coverage = spokenMs / durationMs;
      if (coverage < MIN_SPEECH_COVERAGE_RATIO) {
        return {
          ok: false,
          reason: 'low_speech_coverage',
          detail: { coverage: Number(coverage.toFixed(4)), spokenMs, durationMs },
        };
      }
    }
  }

  return { ok: true, reason: null, detail: { wordCount } };
}
