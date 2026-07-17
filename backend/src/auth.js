import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { collectServiceBalances } from './balances.js';
import { query } from './db.js';
// Цикл auth ↔ notifications безопасен: notifyNewLogin зовётся в рантайме
// (обработчик логина), а не при загрузке модуля.
import { notifyNewLogin } from './notifications.js';
import { MEETING_TYPES } from './protocolTemplates.js';
import { deleteRecordingAudio } from './storage.js';
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  enabledProviders,
  exchangeCodeForProfile,
  isProviderEnabled,
  isTelegramLoginEnabled,
  redirectUri,
  telegramLoginConfig,
  verifyTelegramLogin,
} from './oauth.js';

const SESSION_COOKIE = 'voxmate_session';
const SESSION_TTL_DAYS = 30;
// Закрытая регистрация (ALLOW_REGISTRATION=false) — доступ в приложение только
// у существующих аккаунтов. Так вход по паролю аккаунта служит защитой всего
// PWA вместо Basic Auth (который ломает устанавливаемость). По умолчанию
// открыта, чтобы не ломать локальную разработку.
const REGISTRATION_ENABLED = process.env.ALLOW_REGISTRATION !== 'false';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        const key = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
        const value = separatorIndex === -1 ? '' : part.slice(separatorIndex + 1);

        // A malformed %-sequence in any cookie (even one set by an unrelated
        // app on the same host) must not turn every API request into a 500.
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      }),
  );
}

// In-memory fixed-window limiter for the unauthenticated auth endpoints -
// enough to stop online password brute-force and mass account creation
// against a single-process API (which this deployment is; a multi-process
// setup would need a shared store instead).
const RATE_BUCKETS = new Map();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();

  // Opportunistic purge so abandoned keys don't accumulate forever.
  if (RATE_BUCKETS.size > 10000) {
    for (const [existingKey, entry] of RATE_BUCKETS) {
      if (now - entry.windowStart >= entry.windowMs) {
        RATE_BUCKETS.delete(existingKey);
      }
    }
  }

  const entry = RATE_BUCKETS.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    RATE_BUCKETS.set(key, { windowStart: now, windowMs, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > limit;
}

// Caddy fronts the API in production and appends the real client IP to
// X-Forwarded-For; direct local requests have no header and share one bucket.
export function clientIp(c) {
  const forwarded = c.req.header('X-Forwarded-For') || '';
  return forwarded.split(',')[0].trim() || 'local';
}

function serializeCookie(name, value, options = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  // The deployed architecture is frontend (laptop) + backend (VPS) on two
  // genuinely different origins, so the session cookie needs SameSite=None
  // to be sent on cross-origin fetch/XHR at all - SameSite=Lax (the old
  // value) is silently dropped by the browser on those requests, which
  // breaks auth for every request after login/register. SameSite=None
  // itself requires Secure, so it's only safe in production (real HTTPS);
  // local dev over plain HTTP keeps Lax; SameSite=None without Secure would
  // just be rejected outright by the browser there.
  const sameSite = isProduction ? 'None' : 'Lax';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (isProduction) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash || '').split('$');

  if (algorithm !== 'scrypt' || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function mapUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSmtpConfig(input = {}, previous = {}) {
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const port = Number(input.port || 587);
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const from = typeof input.from === 'string' ? input.from.trim() : '';
  const passInput = typeof input.pass === 'string' ? input.pass : '';
  const pass = passInput || previous.pass || '';

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: Boolean(input.secure),
    user,
    pass,
    from,
  };
}

function publicSmtpConfig(config = {}) {
  return {
    host: config.host || '',
    port: config.port || 587,
    secure: Boolean(config.secure),
    user: config.user || '',
    from: config.from || '',
    hasPassword: Boolean(config.pass),
  };
}

function normalizeTelegramConfig(input = {}, previous = {}) {
  const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  const tokenInput = typeof input.botToken === 'string' ? input.botToken.trim() : '';
  const botToken = tokenInput || previous.botToken || '';

  return { chatId, botToken };
}

function publicTelegramConfig(config = {}) {
  return {
    chatId: config.chatId || '',
    hasToken: Boolean(config.botToken),
  };
}

function normalizeBitrixConfig(input = {}, previous = {}) {
  const defaultResponsibleId = typeof input.defaultResponsibleId === 'string' ? input.defaultResponsibleId.trim() : '';
  const defaultGroupId = typeof input.defaultGroupId === 'string' ? input.defaultGroupId.trim() : '';
  const webhookInput = typeof input.webhookUrl === 'string' ? input.webhookUrl.trim() : '';
  const webhookUrl = webhookInput || previous.webhookUrl || '';

  return { webhookUrl, defaultResponsibleId, defaultGroupId };
}

function publicBitrixConfig(config = {}) {
  return {
    defaultResponsibleId: config.defaultResponsibleId || '',
    defaultGroupId: config.defaultGroupId || '',
    hasWebhook: Boolean(config.webhookUrl),
  };
}

const DIARIZATION_METHODS = new Set(['shopot', 'gemini', 'speech2text', 'kimi', 'pipeline', 'off']);
// '' means auto-detect - matches the NFR spec ("русский, английский; автоопределение").
const ASR_LANGUAGES = new Set(['', 'ru', 'en']);

function normalizeDiarizationConfig(input = {}, previous = {}) {
  const method = DIARIZATION_METHODS.has(input.method) ? input.method : previous.method || 'shopot';
  const shopotKeyInput = typeof input.shopotApiKey === 'string' ? input.shopotApiKey.trim() : '';
  const shopotApiKey = shopotKeyInput || previous.shopotApiKey || '';
  const geminiModel = typeof input.geminiModel === 'string' && input.geminiModel.trim()
    ? input.geminiModel.trim()
    : previous.geminiModel || 'google/gemini-2.5-pro';
  const speech2textKeyInput = typeof input.speech2textApiKey === 'string' ? input.speech2textApiKey.trim() : '';
  const speech2textApiKey = speech2textKeyInput || previous.speech2textApiKey || '';
  const kimiModel = typeof input.kimiModel === 'string' && input.kimiModel.trim()
    ? input.kimiModel.trim()
    : previous.kimiModel || 'moonshotai/kimi-k2.6';
  const language = ASR_LANGUAGES.has(input.language) ? input.language : previous.language ?? '';

  return { method, shopotApiKey, geminiModel, speech2textApiKey, kimiModel, language };
}

function publicDiarizationConfig(config = {}) {
  return {
    method: config.method || 'shopot',
    hasShopotKey: Boolean(config.shopotApiKey),
    geminiModel: config.geminiModel || 'google/gemini-2.5-pro',
    hasSpeech2textKey: Boolean(config.speech2textApiKey),
    kimiModel: config.kimiModel || 'moonshotai/kimi-k2.6',
    language: config.language || '',
  };
}

// 'in_app' always gets a notifications row written regardless of this list
// (it's the persistent history/read-status ledger - see notifications.js);
// this config only controls which EXTERNAL channels also fire, capped at 2
// channels total including in_app, per the product spec.
const NOTIFICATION_CHANNELS = new Set(['in_app', 'email', 'telegram']);

function normalizeNotificationConfig(input = {}, previous = {}) {
  const rawChannels = Array.isArray(input.channels) ? input.channels : previous.channels;
  const channels = Array.isArray(rawChannels)
    ? [...new Set(rawChannels.filter((channel) => NOTIFICATION_CHANNELS.has(channel)))].slice(0, 2)
    : ['in_app', 'email'];
  const dnd = typeof input.dnd === 'boolean' ? input.dnd : Boolean(previous.dnd);

  return { channels, dnd };
}

function publicNotificationConfig(config = {}) {
  return {
    channels: Array.isArray(config.channels) && config.channels.length ? config.channels : ['in_app', 'email'],
    dnd: Boolean(config.dnd),
  };
}

// US-11.1: «Подтверждение и предпросмотр — по настройке». По умолчанию
// предпросмотр включён: отправка — необратимое действие наружу, и спека требует
// подтверждать её всегда (раздел про AI: «Всегда с подтверждением: ... отправка»).
const SEND_CHANNELS = new Set(['email', 'telegram']);

function normalizeSendConfig(input = {}, previous = {}) {
  const preview = typeof input.preview === 'boolean' ? input.preview : previous.preview;
  const defaultChannel = SEND_CHANNELS.has(input.defaultChannel)
    ? input.defaultChannel
    : SEND_CHANNELS.has(previous.defaultChannel)
      ? previous.defaultChannel
      : 'email';
  const attachDocx = typeof input.attachDocx === 'boolean' ? input.attachDocx : previous.attachDocx;

  return {
    preview: preview === undefined ? true : preview,
    defaultChannel,
    attachDocx: attachDocx === undefined ? true : attachDocx,
  };
}

function publicSendConfig(config = {}) {
  return normalizeSendConfig(config, config);
}

/**
 * Находит или создаёт аккаунт по внешней личности (US-16.1). Порядок:
 * 1) уже связанная личность → её аккаунт; 2) совпадение по e-mail (провайдер
 * его подтвердил) → связываем с существующим аккаунтом; 3) иначе новый аккаунт.
 * Так «Совпадение email → тот же аккаунт» из спеки выполняется автоматически.
 */
async function findOrCreateOauthUser(provider, profile) {
  const existing = await query(
    `select u.id, u.display_name, u.email, u.created_at, u.updated_at
     from oauth_identities i join app_users u on u.id = i.user_id
     where i.provider = $1 and i.provider_user_id = $2`,
    [provider, profile.id],
  );

  if (existing.rowCount) {
    return mapUser(existing.rows[0]);
  }

  const email = profile.email ? normalizeEmail(profile.email) : null;
  let user = null;

  if (email) {
    const byEmail = await query('select id, display_name, email, created_at, updated_at from app_users where email = $1', [email]);
    if (byEmail.rowCount) {
      user = mapUser(byEmail.rows[0]);
    }
  }

  if (!user) {
    const created = await query(
      'insert into app_users (display_name, email) values ($1, $2) returning id, display_name, email, created_at, updated_at',
      [profile.name || email || `Пользователь ${provider}`, email],
    );
    user = mapUser(created.rows[0]);
  }

  await query(
    `insert into oauth_identities (provider, provider_user_id, user_id, email)
     values ($1, $2, $3, $4)
     on conflict (provider, provider_user_id) do update set user_id = excluded.user_id`,
    [provider, profile.id, user.id, email],
  );

  return user;
}

async function createSession(userId, context = {}) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const userAgent = (context.userAgent || '').slice(0, 400) || null;
  const ip = context.ip || null;

  await query(
    `
      insert into auth_sessions (user_id, token_hash, expires_at, user_agent, ip, last_ip)
      values ($1, $2, $3, $4, $5, $5)
    `,
    [userId, tokenHash, expiresAt, userAgent, ip],
  );

  return {
    token,
    cookie: serializeCookie(SESSION_COOKIE, token, {
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
      expires: expiresAt,
    }),
  };
}

async function getCurrentUser(c) {
  const cookies = parseCookies(c.req.header('Cookie'));
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const result = await query(
    `
      select u.id, u.display_name, u.email, u.created_at, u.updated_at
      from auth_sessions s
      join app_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1
    `,
    [tokenHash],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const seenIp = clientIp(c);
  await query('update auth_sessions set last_seen_at = now(), last_ip = $2 where token_hash = $1', [tokenHash, seenIp === 'local' ? null : seenIp]);
  return mapUser(result.rows[0]);
}

export async function requireAuth(c, next) {
  const user = await getCurrentUser(c);

  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  c.set('currentUser', user);
  await next();
}

export function getAuthUser(c) {
  return c.get('currentUser');
}

// Expired sessions are already invisible to getCurrentUser (expires_at
// filter), but the rows themselves would otherwise accumulate forever.
export async function cleanupExpiredAuthSessions() {
  const result = await query('delete from auth_sessions where expires_at < now()');

  if (result.rowCount > 0) {
    console.log(`Cleaned up ${result.rowCount} expired auth session(s)`);
  }
}

export async function getUserSmtpConfig(userId) {
  const result = await query('select smtp_config from app_users where id = $1', [userId]);
  return result.rows[0]?.smtp_config || null;
}

export async function getUserTelegramConfig(userId) {
  const result = await query('select telegram_config from app_users where id = $1', [userId]);
  return result.rows[0]?.telegram_config || null;
}

export async function getUserBitrixConfig(userId) {
  const result = await query('select bitrix_config from app_users where id = $1', [userId]);
  return result.rows[0]?.bitrix_config || null;
}

export async function getUserDiarizationConfig(userId) {
  const result = await query('select diarization_config from app_users where id = $1', [userId]);
  return result.rows[0]?.diarization_config || null;
}

export async function getUserNotificationConfig(userId) {
  const result = await query('select notification_config from app_users where id = $1', [userId]);
  return result.rows[0]?.notification_config || null;
}

// US-16.2: настройки уровня аккаунта — шаблон протокола по умолчанию и т.п.
const DEFAULT_ACCOUNT_CONFIG = { defaultMeetingType: 'meeting', recordingConsentWarning: true };

function normalizeAccountConfig(input = {}, previous = {}) {
  const base = { ...DEFAULT_ACCOUNT_CONFIG, ...previous };
  const defaultMeetingType = MEETING_TYPES.has(input.defaultMeetingType)
    ? input.defaultMeetingType
    : base.defaultMeetingType;
  const recordingConsentWarning =
    typeof input.recordingConsentWarning === 'boolean' ? input.recordingConsentWarning : base.recordingConsentWarning;

  return { defaultMeetingType, recordingConsentWarning };
}

export async function getUserAccountConfig(userId) {
  const result = await query('select account_config from app_users where id = $1', [userId]);
  return { ...DEFAULT_ACCOUNT_CONFIG, ...(result.rows[0]?.account_config || {}) };
}

export async function getUserSendConfig(userId) {
  const result = await query('select send_config from app_users where id = $1', [userId]);
  return result.rows[0]?.send_config || null;
}

export function registerAuthRoutes(app) {
  app.get('/api/auth/me', async (c) => {
    const user = await getCurrentUser(c);
    return c.json({
      user,
      registrationEnabled: REGISTRATION_ENABLED,
      oauthProviders: enabledProviders(),
      telegramLogin: isTelegramLoginEnabled() ? telegramLoginConfig() : null,
    });
  });

  // US-16.1: Telegram Login Widget шлёт подписанные данные на этот адрес.
  app.get('/api/auth/telegram/callback', async (c) => {
    const appUrl = (process.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
    const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const profile = verifyTelegramLogin(params);

    if (!profile) {
      return c.redirect(`${appUrl}/?auth_error=${encodeURIComponent('Не удалось войти через Telegram')}`);
    }

    try {
      const user = await findOrCreateOauthUser('telegram', profile);
      const session = await createSession(user.id, { userAgent: c.req.header('User-Agent') || '', ip: clientIp(c) });
      c.header('Set-Cookie', session.cookie);
      return c.redirect(`${appUrl}/`);
    } catch (error) {
      console.warn(`Telegram login failed: ${error.message}`);
      return c.redirect(`${appUrl}/?auth_error=${encodeURIComponent('Не удалось войти через Telegram')}`);
    }
  });

  // US-16.1 (ADR-027): вход через внешних провайдеров. Провайдер включается,
  // только если заданы его client_id/secret в окружении.
  app.get('/api/auth/oauth/:provider/start', async (c) => {
    const provider = c.req.param('provider');

    if (!isProviderEnabled(provider)) {
      return c.json({ error: 'Провайдер не настроен' }, 404);
    }

    const { verifier, challenge } = createPkce();
    const state = createState();
    await query('delete from oauth_states where created_at < now() - interval \'15 minutes\'', []);
    await query('insert into oauth_states (state, provider, code_verifier) values ($1, $2, $3)', [state, provider, verifier]);

    const uri = redirectUri(provider, c.req.url);
    return c.redirect(buildAuthorizeUrl(provider, { state, challenge, redirectUri: uri }));
  });

  app.get('/api/auth/oauth/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const appUrl = (process.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/+$/, '');

    // Ошибки провайдера и подделки state ведут обратно на экран входа с пометкой.
    const fail = (reason) => c.redirect(`${appUrl}/?auth_error=${encodeURIComponent(reason)}`);

    if (!isProviderEnabled(provider) || !code || !state) {
      return fail('Не удалось войти — повторите попытку');
    }

    const stored = await query('delete from oauth_states where state = $1 and provider = $2 returning code_verifier', [
      state,
      provider,
    ]);

    if (!stored.rowCount) {
      return fail('Сессия входа устарела — повторите попытку');
    }

    try {
      const uri = redirectUri(provider, c.req.url);
      const profile = await exchangeCodeForProfile(provider, { code, codeVerifier: stored.rows[0].code_verifier, redirectUri: uri });
      const user = await findOrCreateOauthUser(provider, profile);
      const session = await createSession(user.id, { userAgent: c.req.header('User-Agent') || '', ip: clientIp(c) });

      c.header('Set-Cookie', session.cookie);
      return c.redirect(`${appUrl}/`);
    } catch (error) {
      console.warn(`OAuth ${provider} callback failed: ${error.message}`);
      return fail('Не удалось войти через провайдера');
    }
  });

  app.get('/api/settings/smtp', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserSmtpConfig(user.id);

    return c.json({ smtp: publicSmtpConfig(config || {}) });
  });

  app.patch('/api/settings/smtp', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserSmtpConfig(user.id)) || {};
    const config = normalizeSmtpConfig(body, previous);

    await query('update app_users set smtp_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ smtp: publicSmtpConfig(config) });
  });

  app.get('/api/settings/telegram', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserTelegramConfig(user.id);

    return c.json({ telegram: publicTelegramConfig(config || {}) });
  });

  app.patch('/api/settings/telegram', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserTelegramConfig(user.id)) || {};
    const config = normalizeTelegramConfig(body, previous);

    await query('update app_users set telegram_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ telegram: publicTelegramConfig(config) });
  });

  app.get('/api/settings/bitrix', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserBitrixConfig(user.id);

    return c.json({ bitrix: publicBitrixConfig(config || {}) });
  });

  app.patch('/api/settings/bitrix', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserBitrixConfig(user.id)) || {};
    const config = normalizeBitrixConfig(body, previous);

    await query('update app_users set bitrix_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ bitrix: publicBitrixConfig(config) });
  });

  app.get('/api/settings/diarization', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserDiarizationConfig(user.id);

    return c.json({ diarization: publicDiarizationConfig(config || {}) });
  });

  app.patch('/api/settings/diarization', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserDiarizationConfig(user.id)) || {};
    const config = normalizeDiarizationConfig(body, previous);

    await query('update app_users set diarization_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ diarization: publicDiarizationConfig(config) });
  });

  app.get('/api/settings/notifications', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserNotificationConfig(user.id);

    return c.json({ notifications: publicNotificationConfig(config || {}) });
  });

  app.patch('/api/settings/notifications', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserNotificationConfig(user.id)) || {};
    const config = normalizeNotificationConfig(body, previous);

    await query('update app_users set notification_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ notifications: publicNotificationConfig(config) });
  });

  // Баланс облачных сервисов: живая проверка по запросу, без кеша — цифра
  // нужна как раз в тот момент, когда на неё смотрят.
  app.get('/api/settings/balances', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const diarizationConfig = (await getUserDiarizationConfig(user.id)) || {};

    return c.json({ balances: await collectServiceBalances(diarizationConfig) });
  });

  app.get('/api/settings/send', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserSendConfig(user.id);

    return c.json({ send: publicSendConfig(config || {}) });
  });

  app.patch('/api/settings/send', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserSendConfig(user.id)) || {};
    const config = normalizeSendConfig(body, previous);

    await query('update app_users set send_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ send: publicSendConfig(config) });
  });

  app.post('/api/auth/register', async (c) => {
    if (!REGISTRATION_ENABLED) {
      return c.json({ error: 'Регистрация закрыта — обратитесь к администратору' }, 403);
    }

    if (isRateLimited(`register:${clientIp(c)}`, 5, 60 * 60 * 1000)) {
      return c.json({ error: 'Too many registration attempts - try again later' }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : email.split('@')[0];

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email is required' }, 400);
    }

    if (password.length < 6) {
      return c.json({ error: 'Password must be at least 6 characters' }, 400);
    }

    // `on conflict` instead of check-then-insert - two concurrent registers
    // for the same email otherwise race past the check and the loser dies
    // with a raw unique-violation 500 instead of this 409.
    const inserted = await query(
      `
        insert into app_users (display_name, email, password_hash)
        values ($1, $2, $3)
        on conflict (email) do nothing
        returning id, display_name, email, created_at, updated_at
      `,
      [displayName, email, hashPassword(password)],
    );

    if (inserted.rowCount === 0) {
      return c.json({ error: 'User already exists' }, 409);
    }

    const user = mapUser(inserted.rows[0]);
    const session = await createSession(user.id, { userAgent: c.req.header('User-Agent') || '', ip: clientIp(c) });

    c.header('Set-Cookie', session.cookie);
    return c.json({ user }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    // Keyed on IP+email so one address being brute-forced doesn't lock the
    // whole office NAT out of every other account.
    if (isRateLimited(`login:${clientIp(c)}:${email}`, 10, 15 * 60 * 1000)) {
      return c.json({ error: 'Too many login attempts - try again later' }, 429);
    }

    const result = await query(
      `
        select id, display_name, email, password_hash, created_at, updated_at
        from app_users
        where email = $1
        limit 1
      `,
      [email],
    );

    if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const user = mapUser(result.rows[0]);
    const context = { userAgent: c.req.header('User-Agent') || '', ip: clientIp(c) };

    // US-16.1: уведомление о новом входе. «Новое» — устройство/браузер, с
    // которого ещё не входили (по user-agent); первый вход аккаунта не тревожим.
    const known = await query(
      'select 1 from auth_sessions where user_id = $1 and user_agent is not distinct from $2 limit 1',
      [user.id, context.userAgent.slice(0, 400) || null],
    );
    const priorSessions = await query('select count(*)::int as n from auth_sessions where user_id = $1', [user.id]);

    if (known.rowCount === 0 && priorSessions.rows[0].n > 0) {
      await notifyNewLogin(user.id, context);
    }

    const session = await createSession(user.id, context);

    c.header('Set-Cookie', session.cookie);
    return c.json({ user });
  });

  app.post('/api/auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('Cookie'));
    const token = cookies[SESSION_COOKIE];

    if (token) {
      await query('delete from auth_sessions where token_hash = $1', [hashToken(token)]);
    }

    c.header(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', {
        maxAge: 0,
        expires: new Date(0),
      }),
    );
    return c.json({ ok: true });
  });

  // US-16.1: список устройств/сессий с пометкой текущей.
  app.get('/api/auth/sessions', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const cookies = parseCookies(c.req.header('Cookie'));
    const currentHash = cookies[SESSION_COOKIE] ? hashToken(cookies[SESSION_COOKIE]) : null;

    const result = await query(
      `select id, token_hash, user_agent, coalesce(last_ip, ip) as ip, created_at, last_seen_at
       from auth_sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`,
      [user.id],
    );

    return c.json({
      sessions: result.rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        ip: row.ip,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        current: row.token_hash === currentHash,
      })),
    });
  });

  // Завершить чужую сессию (US-16.1). Текущую завершают через /logout.
  app.delete('/api/auth/sessions/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const result = await query('delete from auth_sessions where id = $1 and user_id = $2 returning id', [
      c.req.param('id'),
      user.id,
    ]);

    return result.rowCount ? c.json({ ok: true }) : c.json({ error: 'Сессия не найдена' }, 404);
  });

  // Завершить все сессии, кроме текущей.
  app.post('/api/auth/sessions/revoke-others', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const cookies = parseCookies(c.req.header('Cookie'));
    const currentHash = cookies[SESSION_COOKIE] ? hashToken(cookies[SESSION_COOKIE]) : '';

    const result = await query('delete from auth_sessions where user_id = $1 and token_hash <> $2 returning id', [
      user.id,
      currentHash,
    ]);

    return c.json({ revoked: result.rowCount });
  });

  app.get('/api/settings/account', requireAuth, async (c) => {
    const user = getAuthUser(c);
    return c.json({ account: await getUserAccountConfig(user.id) });
  });

  app.patch('/api/settings/account', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = await getUserAccountConfig(user.id);
    const config = normalizeAccountConfig(body, previous);

    await query('update app_users set account_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ account: config });
  });

  /**
   * US-16.1/16.4: удаление аккаунта. Требует пароль — необратимо: каскад (после
   * миграции 023) сносит записи, проекты, контакты, задачи, привязки. Аудио в
   * объектном хранилище удаляем отдельно — на него каскад БД не распространяется.
   */
  app.post('/api/auth/delete-account', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    const result = await query('select password_hash from app_users where id = $1', [user.id]);

    if (!result.rowCount || !verifyPassword(String(body.password || ''), result.rows[0].password_hash)) {
      return c.json({ error: 'Неверный пароль' }, 403);
    }

    // Ключи аудио собираем до удаления строк — потом их взять будет неоткуда.
    const audio = await query('select storage_key from recordings where owner_id = $1 and storage_key is not null', [
      user.id,
    ]);

    await query('delete from app_users where id = $1', [user.id]);

    for (const row of audio.rows) {
      try {
        await deleteRecordingAudio(row.storage_key);
      } catch (error) {
        console.warn(`Failed to delete audio ${row.storage_key} on account removal: ${error.message}`);
      }
    }

    c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, expires: new Date(0) }));
    return c.json({ ok: true });
  });
}
