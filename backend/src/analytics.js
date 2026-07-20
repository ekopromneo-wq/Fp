/**
 * Этап 9 (NFR §6/§9): продуктовая аналитика и воронка активации.
 *
 * ПРИНЦИП 152-ФЗ: аналитика НЕ содержит аудио, текста встреч, имён и контактов.
 * Пишем только имя события из белого списка + скалярные признаки (props).
 * user_id/recording_id — псевдонимные UUID, нужны для воронки и ретеншена.
 *
 * track() намеренно «тихий»: аналитика не должна ломать пользовательские потоки,
 * поэтому ошибки логируются и глотаются, запись идёт fire-and-forget.
 */
import { query } from './db.js';
import { requireAuth, getAuthUser } from './auth.js';

// Белый список событий. Всё, что не здесь, отклоняется — защита от опечаток и от
// утечки произвольных (возможно, содержательных) имён событий с фронта.
export const ANALYTICS_EVENTS = Object.freeze([
  // Воронка активации
  'recording_created',
  'processing_started',
  'protocol_ready',
  'processing_failed',
  'tasks_opened',
  // Доставка (US-11.1)
  'delivery_sent',
  'delivery_failed',
  // Именованные события неполных задач (NFR §6)
  'incomplete_task_confirmed',
  'incomplete_task_sent_email',
  'incomplete_task_sent_telegram',
  'incomplete_task_blocked_b24',
  'task_sent_bitrix',
  // Экономика обработки (ADR-033 §2.7)
  'quota_soft_warning',
  'quota_hard_block',
  'processing_cost_exceeded',
  'processing_waiting_quota',
  // Надёжность
  'offline_recovery',
]);

// События, которые вправе слать фронтенд напрямую (остальные — только сервер,
// из доверенных мест в коде).
const FRONTEND_EVENTS = new Set(['tasks_opened', 'offline_recovery']);

const ALLOWED = new Set(ANALYTICS_EVENTS);

// props очищаем до скаляров: строки (короткие), числа, булевы. Никаких объектов,
// массивов и длинных строк — чтобы в аналитику не просочилось содержимое.
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;

  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      // Короткая метка (канал, источник, статус) — не свободный текст.
      out[key] = value.slice(0, 64);
    }
  }

  return out;
}

/**
 * Fire-and-forget запись события. Никогда не бросает. Возвращает промис, который
 * можно (но не обязательно) дождаться.
 */
export function track(event, { userId = null, recordingId = null, props = {} } = {}) {
  if (!ALLOWED.has(event)) {
    console.warn(`analytics: неизвестное событие "${event}" — пропущено`);
    return Promise.resolve();
  }

  return query(
    `insert into analytics_events (event, user_id, recording_id, props)
     values ($1, $2, $3, $4::jsonb)`,
    [event, userId, recordingId, JSON.stringify(sanitizeProps(props))],
  ).catch((error) => {
    console.warn(`analytics: не удалось записать "${event}":`, error.message);
  });
}

// Кто вправе смотреть агрегированные метрики. Если ANALYTICS_ADMINS не задан —
// любой аутентифицированный пользователь (данные агрегированные, без ПДн).
function isAnalyticsAdmin(email) {
  const list = (process.env.ANALYTICS_ADMINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (list.length === 0) return true;
  return list.includes(String(email || '').toLowerCase());
}

/**
 * Агрегированные продуктовые метрики (§9) за окно в днях. Всё — счётчики и
 * производные доли, без разворачивания в отдельных пользователей.
 */
export async function getProductMetrics({ days = 30 } = {}) {
  const since = `now() - ($1 || ' days')::interval`;

  const [counts, activation, ttfp, delivery, incompleteRate, retention, economics] = await Promise.all([
    // Счётчики по каждому событию.
    query(
      `select event, count(*)::int as n
       from analytics_events where created_at >= ${since}
       group by event order by n desc`,
      [String(days)],
    ),
    // Воронка активации: пользователи с записью → с протоколом → открывшие задачи.
    query(
      `select
         count(distinct user_id) filter (where event = 'recording_created')::int as with_recording,
         count(distinct user_id) filter (where event = 'protocol_ready')::int   as with_protocol,
         count(distinct user_id) filter (where event = 'tasks_opened')::int      as with_tasks_opened
       from analytics_events where created_at >= ${since} and user_id is not null`,
      [String(days)],
    ),
    // Медианное время до первого протокола (сек) по записи.
    query(
      `with per_recording as (
         select recording_id,
                min(created_at) filter (where event = 'recording_created') as created,
                min(created_at) filter (where event = 'protocol_ready')    as ready
         from analytics_events
         where recording_id is not null and created_at >= ${since}
         group by recording_id
       )
       select percentile_cont(0.5) within group (
                order by extract(epoch from (ready - created))
              ) as median_seconds
       from per_recording where created is not null and ready is not null and ready >= created`,
      [String(days)],
    ),
    // Доставка по каналам: успех/провал.
    query(
      `select props->>'channel' as channel,
              count(*) filter (where event = 'delivery_sent')::int   as sent,
              count(*) filter (where event = 'delivery_failed')::int as failed
       from analytics_events
       where event in ('delivery_sent','delivery_failed') and created_at >= ${since}
       group by props->>'channel'`,
      [String(days)],
    ),
    // Доля отправленных неполных задач относительно подтверждённых неполных.
    query(
      `select
         count(*) filter (where event = 'incomplete_task_confirmed')::int as confirmed,
         count(*) filter (where event in ('incomplete_task_sent_email','incomplete_task_sent_telegram'))::int as sent
       from analytics_events where created_at >= ${since}`,
      [String(days)],
    ),
    // Ретеншен D14: пользователи, у кого есть событие и через ≥14 дней после
    // первого события (грубая оценка на доступном окне).
    query(
      `with firsts as (
         select user_id, min(created_at) as first_at, max(created_at) as last_at
         from analytics_events where user_id is not null
         group by user_id
       )
       select
         count(*)::int as total_users,
         count(*) filter (where last_at >= first_at + interval '14 days')::int as retained_d14
       from firsts`,
      [],
    ),
    // ADR-033 §2.7: себестоимость и попадания в квоту. Стоимость/минуты — из
    // usage_ledger (реальный расход). quota_hit_rate — доля попыток обработки,
    // упёршихся в хард-лимит: hard_block / (hard_block + processing_started).
    // Ограничена [0,1] и не зависит от того, как создавалась запись.
    query(
      `select
         coalesce((select sum(cost_usd) from usage_ledger where created_at >= ${since}), 0)::float as total_cost_usd,
         coalesce((select sum(asr_minutes) from usage_ledger where created_at >= ${since}), 0)::float as total_asr_minutes,
         (select count(*) from analytics_events
            where event = 'quota_hard_block' and created_at >= ${since})::int as quota_hard_blocks,
         (select count(*) from analytics_events
            where event = 'processing_started' and created_at >= ${since})::int as processing_starts`,
      [String(days)],
    ),
  ]);

  const a = activation.rows[0] || {};
  const withRecording = a.with_recording || 0;
  const activatedUsers = Math.min(a.with_protocol || 0, withRecording);
  const inc = incompleteRate.rows[0] || {};
  const ret = retention.rows[0] || {};
  const eco = economics.rows[0] || {};
  const totalCostUsd = eco.total_cost_usd || 0;
  const totalAsrMinutes = eco.total_asr_minutes || 0;

  const deliveryByChannel = {};
  for (const row of delivery.rows) {
    const total = (row.sent || 0) + (row.failed || 0);
    deliveryByChannel[row.channel || 'unknown'] = {
      sent: row.sent || 0,
      failed: row.failed || 0,
      successRate: total ? Number((row.sent / total).toFixed(3)) : null,
    };
  }

  return {
    windowDays: days,
    eventCounts: Object.fromEntries(counts.rows.map((r) => [r.event, r.n])),
    activation: {
      withRecording,
      withProtocol: a.with_protocol || 0,
      withTasksOpened: a.with_tasks_opened || 0,
      activationRate: withRecording ? Number((activatedUsers / withRecording).toFixed(3)) : null,
    },
    timeToFirstProtocolSeconds: ttfp.rows[0]?.median_seconds != null ? Math.round(ttfp.rows[0].median_seconds) : null,
    deliveryByChannel,
    incompleteTaskSentRate: inc.confirmed ? Number((inc.sent / inc.confirmed).toFixed(3)) : null,
    retentionD14: ret.total_users ? Number((ret.retained_d14 / ret.total_users).toFixed(3)) : null,
    // ADR-033 §2.7: экономика обработки.
    economics: {
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      totalAsrMinutes: Number(totalAsrMinutes.toFixed(1)),
      costPerMeetingMinute: totalAsrMinutes ? Number((totalCostUsd / totalAsrMinutes).toFixed(5)) : null,
      costPerActivatedUser: activatedUsers ? Number((totalCostUsd / activatedUsers).toFixed(4)) : null,
      quotaHitRate: (() => {
        const blocks = eco.quota_hard_blocks || 0;
        const attempts = blocks + (eco.processing_starts || 0);
        return attempts ? Number((blocks / attempts).toFixed(3)) : null;
      })(),
    },
  };
}

export function registerAnalyticsRoutes(app) {
  /** Приём событий с фронтенда (ограниченный белый список FRONTEND_EVENTS). */
  app.post('/api/analytics/track', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    if (!FRONTEND_EVENTS.has(body.event)) {
      return c.json({ error: 'Событие не разрешено к отправке с клиента' }, 400);
    }

    await track(body.event, {
      userId: user.id,
      recordingId: typeof body.recordingId === 'string' ? body.recordingId : null,
      props: body.props,
    });

    return c.json({ ok: true });
  });

  /** Агрегированные продуктовые метрики (§9). */
  app.get('/api/analytics/metrics', requireAuth, async (c) => {
    const user = getAuthUser(c);

    if (!isAnalyticsAdmin(user.email)) {
      return c.json({ error: 'Недостаточно прав' }, 403);
    }

    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
    return c.json({ metrics: await getProductMetrics({ days }) });
  });
}
