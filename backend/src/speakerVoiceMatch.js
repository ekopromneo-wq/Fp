import { query } from './db.js';

// Пороги подобраны по аналогии с типичными cosine-similarity порогами для
// speaker-embedding моделей (0.75-0.95 диапазон "тот же голос" у большинства
// вендоров) - без датасета для калибровки под конкретно Speech2Text это
// осторожная отправная точка, не проверенная на большой выборке; если будут
// ложные срабатывания/пропуски - в первую очередь смотреть сюда.
const HIGH_CONFIDENCE_THRESHOLD = 0.86;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.8;

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Сравнивает голосовой вектор спикера этой записи со всеми сохранёнными
 * профилями владельца, возвращает лучшее совпадение выше медианного порога
 * или null. Используется, чтобы предложить имя спикера по голосу (US: та же
 * инфраструктура подсказок, что уже есть у accuracy-пайплайна - suggested_name/
 * suggestion_confidence/suggestion_evidence на recording_speakers).
 */
export async function findBestVoiceMatch(ownerId, vector) {
  if (!Array.isArray(vector) || !vector.length) {
    return null;
  }

  const result = await query('select display_name, vector from speaker_voice_profiles where owner_id = $1', [ownerId]);

  let best = null;
  for (const row of result.rows) {
    const profileVector = Array.isArray(row.vector) ? row.vector : [];
    const similarity = cosineSimilarity(vector, profileVector);

    if (!best || similarity > best.similarity) {
      best = { name: row.display_name, similarity };
    }
  }

  if (!best || best.similarity < MEDIUM_CONFIDENCE_THRESHOLD) {
    return null;
  }

  return {
    name: best.name,
    confidence: best.similarity >= HIGH_CONFIDENCE_THRESHOLD ? 'high' : 'medium',
    similarity: best.similarity,
  };
}

/**
 * Обучает/обновляет профиль голоса для владельца+имени усреднением с уже
 * накопленными образцами (sample_count) - профиль постепенно устойчивее к
 * шуму отдельной записи (фоновый шум, короткая реплика) по мере того, как
 * один и тот же человек подтверждается в новых встречах.
 */
export async function upsertVoiceProfile(ownerId, displayName, vector) {
  if (!Array.isArray(vector) || !vector.length) {
    return;
  }

  const existing = await query(
    'select vector, sample_count from speaker_voice_profiles where owner_id = $1 and display_name = $2',
    [ownerId, displayName],
  );

  let finalVector = vector;
  let sampleCount = 1;

  if (existing.rowCount) {
    const prevVector = Array.isArray(existing.rows[0].vector) ? existing.rows[0].vector : [];
    const prevCount = existing.rows[0].sample_count || 1;

    if (prevVector.length === vector.length) {
      sampleCount = prevCount + 1;
      finalVector = vector.map((value, index) => (prevVector[index] * prevCount + value) / sampleCount);
    }
  }

  await query(
    `
      insert into speaker_voice_profiles (owner_id, display_name, vector, sample_count, updated_at)
      values ($1, $2, $3::jsonb, $4, now())
      on conflict (owner_id, display_name) do update
      set vector = excluded.vector, sample_count = excluded.sample_count, updated_at = now()
    `,
    [ownerId, displayName, JSON.stringify(finalVector), sampleCount],
  );
}
