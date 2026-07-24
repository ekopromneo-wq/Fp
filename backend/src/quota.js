// ADR-033: экономика обработки — квоты, учёт расхода и предохранители.
//
// Единица учёта — минута обработки (audio-minute): и ASR, и LLM масштабируются от
// длительности. Считаем по фактической длительности записи (duration_seconds).
//
// Пилот идёт с ФИКСИРОВАННЫМИ квотами на всех (решение владельца, платёжного
// контура нет). Значения — из окружения; таблица account_quotas нужна лишь для
// переопределений отдельным пользователям.
//
// Важно (§2.4): гейтится ТОЛЬКО обработка. Запись всегда сохранена (offline-first,
// эпик 1) и при хард-лимите переходит в статус 'waiting_quota', а не теряется.

import { query } from './db.js';

function envNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function quotaConfig() {
  return {
    // Квоты аккаунта (пилот — одинаковые для всех).
    monthlyMinutes: envNum('QUOTA_MONTHLY_MINUTES', 600), // ~10 часов/мес
    dailyMinutes: envNum('QUOTA_DAILY_MINUTES', 180), // дневной rate-cap, ~3 часа/сутки
    maxParallel: envNum('QUOTA_MAX_PARALLEL', 2), // одновременных обработок на аккаунт
    softRatio: envNum('QUOTA_SOFT_RATIO', 0.8), // софт-предупреждение при 80% месячной квоты
    // Предохранители воркера/сервиса.
    meetingCostCeilingUsd: envNum('MEETING_COST_CEILING_USD', 2), // потолок стоимости одной встречи
    dailyBudgetCapUsd: envNum('DAILY_BUDGET_CAP_USD', 50), // дневной бюджет на весь сервис
    // Прайс для оценки стоимости (best-effort; фиксируется в леджере на момент операции).
    asrCostPerMinuteUsd: envNum('ASR_COST_PER_MINUTE_USD', 0.006),
    llmCostPer1kInUsd: envNum('LLM_COST_PER_1K_IN_USD', 0.005),
    llmCostPer1kOutUsd: envNum('LLM_COST_PER_1K_OUT_USD', 0.015),
  };
}

// Лимиты аккаунта = дефолты из env, переопределённые строкой account_quotas (если есть).
export async function getAccountLimits(userId) {
  const cfg = quotaConfig();
  const limits = {
    monthlyMinutes: cfg.monthlyMinutes,
    dailyMinutes: cfg.dailyMinutes,
    maxParallel: cfg.maxParallel,
  };

  if (!userId) {
    return limits;
  }

  const row = await query(
    'select monthly_minutes_limit, daily_minutes_cap, max_parallel_jobs from account_quotas where user_id = $1',
    [userId],
  );

  if (row.rowCount) {
    const o = row.rows[0];
    if (o.monthly_minutes_limit != null) limits.monthlyMinutes = o.monthly_minutes_limit;
    if (o.daily_minutes_cap != null) limits.dailyMinutes = o.daily_minutes_cap;
    if (o.max_parallel_jobs != null) limits.maxParallel = o.max_parallel_jobs;
  }

  return limits;
}

// Текущий расход аккаунта: минуты за календарный месяц/сутки + число обработок в полёте.
export async function getAccountUsage(userId) {
  const [monthly, daily, active] = await Promise.all([
    query(
      "select coalesce(sum(asr_minutes), 0)::float as m from usage_ledger where user_id = $1 and created_at >= date_trunc('month', now())",
      [userId],
    ),
    query(
      "select coalesce(sum(asr_minutes), 0)::float as m from usage_ledger where user_id = $1 and created_at >= date_trunc('day', now())",
      [userId],
    ),
    query(
      "select count(*)::int as n, coalesce(sum(duration_seconds), 0)::float as s from recordings where owner_id = $1 and status in ('queued', 'processing', 'transcribing', 'summarizing')",
      [userId],
    ),
  ]);

  // usage_ledger пишется только по завершении ASR (см. worker.js) - запись,
  // которая уже в очереди/обрабатывается, ещё не отражена там. Без резерва её
  // плановых минут здесь второй enqueueRecording, запущенный до завершения
  // первого, увидел бы тот же "использовано 0" базис и вместе с первым мог бы
  // превысить дневной/месячный лимит (TOCTOU, ADR-033 §2.4).
  const reservedMinutes = active.rows[0].s / 60;

  return {
    monthlyMinutes: monthly.rows[0].m + reservedMinutes,
    dailyMinutes: daily.rows[0].m + reservedMinutes,
    activeJobs: active.rows[0].n,
  };
}

// Дневной расход всего сервиса (для глобального budget-cap).
export async function getGlobalDailySpendUsd() {
  const row = await query(
    "select coalesce(sum(cost_usd), 0)::float as c from usage_ledger where created_at >= date_trunc('day', now())",
  );
  return row.rows[0].c;
}

/**
 * Решение о допуске обработки к очереди (§2.4). Возвращает:
 *   { decision: 'ok' }                       — можно обрабатывать;
 *   { decision: 'soft', reason }             — предупредить, но обрабатывать;
 *   { decision: 'hard', reason }             — заблокировать (→ 'waiting_quota').
 * plannedMinutes — оценка длительности (минуты); при неизвестной длительности (0)
 * минутные лимиты не проверяем (не блокируем вслепую), но параллелизм/бюджет — да.
 */
export async function checkProcessingQuota(userId, plannedMinutes) {
  const cfg = quotaConfig();

  // Глобальный дневной budget-cap — предохранитель на весь сервис (§2.5).
  if (cfg.dailyBudgetCapUsd > 0) {
    const spend = await getGlobalDailySpendUsd();
    if (spend >= cfg.dailyBudgetCapUsd) {
      // Алерт в мониторинг (§2.5): дневной бюджет всего сервиса исчерпан — новые
      // обработки блокируются до следующих суток. Виден в логах воркера/API.
      console.warn(
        `[quota] ГЛОБАЛЬНЫЙ ДНЕВНОЙ БЮДЖЕТ ИСЧЕРПАН: ${spend.toFixed(2)}$ >= ${cfg.dailyBudgetCapUsd}$ — обработка заблокирована`,
      );
      return { decision: 'hard', reason: 'global_budget' };
    }
  }

  if (!userId) {
    return { decision: 'ok' };
  }

  const [limits, usage] = await Promise.all([getAccountLimits(userId), getAccountUsage(userId)]);
  const planned = Number.isFinite(plannedMinutes) && plannedMinutes > 0 ? plannedMinutes : 0;

  // Лимит параллельных обработок на аккаунт.
  if (limits.maxParallel > 0 && usage.activeJobs >= limits.maxParallel) {
    return { decision: 'hard', reason: 'parallel' };
  }

  // Дневной rate-cap по минутам.
  if (limits.dailyMinutes > 0 && planned > 0 && usage.dailyMinutes + planned > limits.dailyMinutes) {
    return { decision: 'hard', reason: 'daily' };
  }

  // Месячный хард-лимит.
  if (limits.monthlyMinutes > 0 && planned > 0 && usage.monthlyMinutes + planned > limits.monthlyMinutes) {
    return { decision: 'hard', reason: 'monthly' };
  }

  // Софт-предупреждение: близко к месячному лимиту, но ещё обрабатываем.
  if (
    limits.monthlyMinutes > 0 &&
    usage.monthlyMinutes + planned > limits.monthlyMinutes * cfg.softRatio
  ) {
    return { decision: 'soft', reason: 'monthly_soft' };
  }

  return { decision: 'ok' };
}

// Стоимость по прайсу на момент операции (фиксируется в леджере).
export function estimateCostUsd({ asrMinutes = 0, tokensIn = 0, tokensOut = 0 } = {}) {
  const cfg = quotaConfig();
  return (
    asrMinutes * cfg.asrCostPerMinuteUsd +
    (tokensIn / 1000) * cfg.llmCostPer1kInUsd +
    (tokensOut / 1000) * cfg.llmCostPer1kOutUsd
  );
}

/**
 * Запись расхода в usage_ledger (§2.3). Никогда не бросает наружу — учёт не должен
 * ломать саму обработку. Возвращает посчитанную стоимость.
 */
export async function recordUsage({
  recordingId = null,
  userId = null,
  asrMinutes = 0,
  tokensIn = 0,
  tokensOut = 0,
  provider = null,
  model = null,
} = {}) {
  const cost = estimateCostUsd({ asrMinutes, tokensIn, tokensOut });

  try {
    await query(
      `insert into usage_ledger
         (recording_id, user_id, asr_minutes, llm_tokens_in, llm_tokens_out, cost_usd, provider, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [recordingId, userId, asrMinutes, tokensIn, tokensOut, cost, provider, model],
    );
  } catch (error) {
    console.warn(`usage_ledger: не удалось записать расход (recording ${recordingId}):`, error.message);
  }

  return cost;
}

// Оценка минут по длительности записи (секунды → минуты).
export function minutesFromSeconds(durationSeconds) {
  const seconds = Number(durationSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : 0;
}
