import crypto from 'node:crypto';
import { query } from './db.js';

export const PAYLOAD_KINDS = ['protocol', 'summary', 'tasks'];
export const CHANNELS = ['email', 'telegram', 'bitrix'];

// US-11.1: «автоповтор 3 раза, затем ошибка».
const MAX_ATTEMPTS = 3;
// Пауза между попытками. Короткая: пользователь ждёт ответа на запрос, а
// повторяем мы только временные сбои канала.
const RETRY_DELAYS_MS = [500, 2000];

const SHARE_TTL_DAYS = 7;

/**
 * Ошибка, которую повторять бессмысленно: канал не настроен, адрес не тот,
 * получатель не найден. US-11.2/11.3 требуют показать такое сразу, а не после
 * трёх попыток.
 */
export class PermanentSendError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

function isPermanentError(error) {
  if (error instanceof PermanentSendError) {
    return true;
  }

  // nodemailer: 5xx от SMTP — окончательный отказ (ящика нет, письмо
  // отклонено), 4xx — «попробуйте позже». EENVELOPE — адрес не принят.
  if (error?.code === 'EENVELOPE') {
    return true;
  }

  if (typeof error?.responseCode === 'number') {
    return error.responseCode >= 500 && error.responseCode < 600;
  }

  return false;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Выполняет отправку с автоповтором временных сбоев (US-11.1). Возвращает
 * результат канала и число потраченных попыток; при провале бросает ошибку с
 * теми же полями, чтобы вызывающий записал их в журнал доставки.
 */
export async function sendWithRetry(send, { maxAttempts = MAX_ATTEMPTS } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await send(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (isPermanentError(error) || attempt >= maxAttempts) {
        const failure = new Error(error.message || 'Не удалось отправить');
        failure.attempts = attempt;
        failure.permanent = isPermanentError(error);
        failure.cause = error;
        throw failure;
      }

      await delay(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1));
    }
  }

  throw lastError;
}

function mapDelivery(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    channel: row.channel,
    payloadKind: row.payload_kind,
    recipients: row.recipients || [],
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    externalRefs: row.external_refs || {},
    createdAt: row.created_at,
  };
}

export async function recordDelivery({
  ownerId,
  recordingId,
  channel,
  payloadKind,
  recipients = [],
  status,
  attempts = 1,
  lastError = null,
  externalRefs = {},
}) {
  const result = await query(
    `
      insert into deliveries (owner_id, recording_id, channel, payload_kind, recipients, status, attempts, last_error, external_refs)
      values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
      returning id, recording_id, channel, payload_kind, recipients, status, attempts, last_error, external_refs, created_at
    `,
    [
      ownerId,
      recordingId,
      channel,
      payloadKind,
      JSON.stringify(recipients),
      status,
      attempts,
      lastError,
      JSON.stringify(externalRefs),
    ],
  );

  return mapDelivery(result.rows[0]);
}

export async function listDeliveries(recordingId, ownerId) {
  const result = await query(
    `
      select id, recording_id, channel, payload_kind, recipients, status, attempts, last_error, external_refs, created_at
      from deliveries
      where recording_id = $1 and owner_id = $2
      order by created_at desc
    `,
    [recordingId, ownerId],
  );

  return result.rows.map(mapDelivery);
}

/**
 * US-11.1: «AI может предложить получателей по истории». Берём фактическую
 * историю доставок владельца — кому он уже успешно слал, тем скорее всего
 * пошлёт снова. Свежесть важнее общего числа отправок, поэтому сортируем по
 * последней отправке.
 */
export async function suggestRecipients(ownerId, channel, { limit = 8 } = {}) {
  const result = await query(
    `
      select recipient, count(*)::int as uses, max(created_at) as last_used_at
      from deliveries, jsonb_array_elements_text(recipients) as recipient
      where owner_id = $1 and channel = $2 and status = 'sent'
      group by recipient
      order by last_used_at desc
      limit $3
    `,
    [ownerId, channel, limit],
  );

  return result.rows.map((row) => ({
    recipient: row.recipient,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
  }));
}

function mapShareLink(row, baseUrl) {
  return {
    id: row.id,
    token: row.token,
    recordingId: row.recording_id,
    payloadKind: row.payload_kind,
    url: buildShareUrl(row.token, baseUrl),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    isActive: !row.revoked_at && new Date(row.expires_at).getTime() > Date.now(),
  };
}

export function buildShareUrl(token, baseUrl) {
  const base = String(baseUrl || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  return `${base}/?share=${token}`;
}

export async function createShareLink({ ownerId, recordingId, payloadKind = 'protocol', baseUrl }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const result = await query(
    `
      insert into share_links (token, owner_id, recording_id, payload_kind, expires_at)
      values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
      returning id, token, recording_id, payload_kind, expires_at, revoked_at, created_at
    `,
    [token, ownerId, recordingId, payloadKind, String(SHARE_TTL_DAYS)],
  );

  return mapShareLink(result.rows[0], baseUrl);
}

export async function listShareLinks(recordingId, ownerId, baseUrl) {
  const result = await query(
    `
      select id, token, recording_id, payload_kind, expires_at, revoked_at, created_at
      from share_links
      where recording_id = $1 and owner_id = $2
      order by created_at desc
    `,
    [recordingId, ownerId],
  );

  return result.rows.map((row) => mapShareLink(row, baseUrl));
}

export async function revokeShareLink(id, ownerId, baseUrl) {
  const result = await query(
    `
      update share_links
      set revoked_at = now()
      where id = $1 and owner_id = $2 and revoked_at is null
      returning id, token, recording_id, payload_kind, expires_at, revoked_at, created_at
    `,
    [id, ownerId],
  );

  return result.rows[0] ? mapShareLink(result.rows[0], baseUrl) : null;
}

/**
 * Разбор публичного токена: различает «нет такой ссылки», «отозвана» и
 * «истекла» — по US-11.1 через неделю ссылка перестаёт действовать, и внешнему
 * читателю стоит объяснить, что именно случилось.
 */
export async function resolveShareToken(token) {
  const result = await query(
    `
      select id, token, recording_id, owner_id, payload_kind, expires_at, revoked_at
      from share_links
      where token = $1
    `,
    [token],
  );

  const row = result.rows[0];

  if (!row) {
    return { status: 'not_found' };
  }

  if (row.revoked_at) {
    return { status: 'revoked' };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { status: 'expired' };
  }

  return { status: 'ok', link: row };
}
