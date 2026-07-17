/**
 * US-16.3/16.4 (152-ФЗ): фиксация и хранение доказательства согласия.
 *
 * Единый источник правды — неизменяемый журнал `consent_events`. Текущее
 * состояние отдельных согласий выводится из последнего события каждого типа.
 * Доступ поддержки дополнительно материализован в app_users.support_access_granted_at
 * (чтобы гейтить доступ одной колонкой), но каждое изменение также пишется в
 * журнал как доказательство.
 *
 * ВАЖНО: обработка (транскрипция/AI) здесь НЕ гейтится по этим согласиям — это
 * legal/продуктовое решение за рамками MVP, а хардгейт сломал бы существующие
 * записи. Здесь мы фиксируем и показываем состояние как юридическую запись.
 */
import { query } from './db.js';
import { requireAuth, getAuthUser, clientIp } from './auth.js';
import {
  consentTextSnapshot,
  CONSENT_TEXTS,
  CONSENT_TEXT_VERSION,
  PROCESSING_CONSENTS,
} from './consentTexts.js';

const PARTICIPANT_MODES = new Set(['consented', 'excluded', 'override']);

/**
 * Пишет одно событие согласия. `action` — grant|decline|revoke. Снимок текста и
 * версия проставляются автоматически по типу, чтобы доказательство фиксировало
 * ровно показанную формулировку.
 */
export async function recordConsentEvent({
  userId,
  recordingId = null,
  consentType,
  action = 'grant',
  detail = {},
  ip = null,
  userAgent = null,
}) {
  const { textVersion, textSnapshot } = consentTextSnapshot(consentType);

  const result = await query(
    `insert into consent_events
       (user_id, recording_id, consent_type, action, text_version, text_snapshot, detail, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     returning id, created_at`,
    [userId, recordingId, consentType, action, textVersion, textSnapshot, JSON.stringify(detail || {}), ip, userAgent],
  );

  return result.rows[0];
}

/** Журнал согласий пользователя (доказательство), новые сверху. */
export async function getConsentHistory(userId, limit = 200) {
  const result = await query(
    `select id, recording_id, consent_type, action, text_version, detail, ip, created_at
     from consent_events
     where user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    recordingId: row.recording_id,
    consentType: row.consent_type,
    action: row.action,
    textVersion: row.text_version,
    detail: row.detail || {},
    ip: row.ip,
    createdAt: row.created_at,
  }));
}

/**
 * Текущее состояние отдельных согласий на обработку — по последнему событию
 * каждого типа. Нет события → не выдано (false).
 */
export async function getProcessingConsentState(userId) {
  const result = await query(
    `select distinct on (consent_type) consent_type, action, created_at
     from consent_events
     where user_id = $1 and consent_type = any($2)
     order by consent_type, created_at desc`,
    [userId, PROCESSING_CONSENTS],
  );

  const state = {};
  for (const type of PROCESSING_CONSENTS) {
    state[type] = { granted: false, at: null };
  }
  for (const row of result.rows) {
    state[row.consent_type] = { granted: row.action === 'grant', at: row.created_at };
  }

  return state;
}

/** Состояние доступа поддержки — из материализованной колонки. */
export async function getSupportAccessState(userId) {
  const result = await query('select support_access_granted_at from app_users where id = $1', [userId]);
  const grantedAt = result.rows[0]?.support_access_granted_at || null;
  return { granted: Boolean(grantedAt), at: grantedAt };
}

/**
 * Выдаёт/отзывает доступ поддержки: обновляет колонку и пишет доказательство.
 * Идемпотентно по смыслу — повторный grant просто обновит момент.
 */
export async function setSupportAccess(userId, granted, { ip = null, userAgent = null } = {}) {
  await query(
    `update app_users
       set support_access_granted_at = case when $2 then now() else null end,
           updated_at = now()
     where id = $1`,
    [userId, granted],
  );

  await recordConsentEvent({
    userId,
    consentType: 'support_access',
    action: granted ? 'grant' : 'revoke',
    ip,
    userAgent,
  });

  return getSupportAccessState(userId);
}

export function registerConsentRoutes(app) {
  /**
   * US-16.3: доказательство согласия на старте КАЖДОЙ записи. Фронт вызывает при
   * подтверждении предупреждения. `mode` — исход ветки отказа участника.
   * recording_id ещё нет (запись создаётся после загрузки) — доказательство
   * привязано ко времени и ip/ua.
   */
  app.post('/api/consent/recording-start', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const mode = PARTICIPANT_MODES.has(body.mode) ? body.mode : 'consented';
    // 'decline' фиксируем как отдельное доказательство «предупреждён и отказался»
    // (запись при этом на клиенте не начинается).
    const action = body.declined ? 'decline' : 'grant';

    const event = await recordConsentEvent({
      userId: user.id,
      consentType: 'participant_notice',
      action,
      detail: { mode },
      ip: clientIp(c),
      userAgent: c.req.header('User-Agent') || null,
    });

    return c.json({ ok: true, eventId: event.id, at: event.created_at });
  });

  /** Журнал согласий (доказательство) для страницы настроек/приватности. */
  app.get('/api/consent/history', requireAuth, async (c) => {
    const user = getAuthUser(c);
    return c.json({ events: await getConsentHistory(user.id) });
  });

  /**
   * Состояние отдельных согласий + доступа поддержки + сами тексты и версия.
   * Тексты отдаём, чтобы фронт показал ровно ту формулировку, снимок которой
   * попадёт в доказательство.
   */
  app.get('/api/settings/consents', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const [processing, supportAccess] = await Promise.all([
      getProcessingConsentState(user.id),
      getSupportAccessState(user.id),
    ]);

    return c.json({
      version: CONSENT_TEXT_VERSION,
      texts: CONSENT_TEXTS,
      processing,
      supportAccess,
    });
  });

  /** Изменение одного отдельного согласия на обработку — пишет доказательство. */
  app.patch('/api/settings/consents', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    if (!PROCESSING_CONSENTS.includes(body.type)) {
      return c.json({ error: 'Неизвестный тип согласия' }, 400);
    }

    if (typeof body.granted !== 'boolean') {
      return c.json({ error: 'granted должен быть boolean' }, 400);
    }

    await recordConsentEvent({
      userId: user.id,
      consentType: body.type,
      action: body.granted ? 'grant' : 'revoke',
      ip: clientIp(c),
      userAgent: c.req.header('User-Agent') || null,
    });

    return c.json({ processing: await getProcessingConsentState(user.id) });
  });

  /** US-16.4: выдать/отозвать доступ поддержки к содержимому. */
  app.post('/api/settings/support-access', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    if (typeof body.granted !== 'boolean') {
      return c.json({ error: 'granted должен быть boolean' }, 400);
    }

    const state = await setSupportAccess(user.id, body.granted, {
      ip: clientIp(c),
      userAgent: c.req.header('User-Agent') || null,
    });

    return c.json({ supportAccess: state });
  });
}
