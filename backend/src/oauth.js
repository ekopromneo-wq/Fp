import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Сравнение секретов/подписей за постоянное время — против timing-атак. Разной
 * длины строки сразу неравны (без утечки через ранний выход самого timingSafeEqual).
 */
export function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Реестр OAuth-провайдеров (ADR-027). Каждый включается, только если заданы его
 * client_id/secret в окружении — иначе кнопка входа не показывается. Все —
 * стандартный authorization-code + PKCE; различаются лишь URL-адресами и тем,
 * как достаётся профиль (см. profile()).
 *
 * Тесты подменяют базовые адреса через OAUTH_<PROVIDER>_* env, чтобы прогнать
 * поток против фальшивого провайдера без реальных приложений.
 */
const REGISTRY = {
  google: {
    label: 'Google',
    // ADR-034: провайдер с email → может быть первичной регистрацией.
    canRegister: true,
    authUrl: () => process.env.OAUTH_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => process.env.OAUTH_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    userinfoUrl: () => process.env.OAUTH_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    profile: (info) => ({
      id: String(info.sub),
      email: info.email,
      emailVerified: info.email_verified === true || info.email_verified === 'true',
      name: info.name || info.email,
    }),
  },
  yandex: {
    label: 'Яндекс',
    // ADR-034: Яндекс отдаёт свой первичный email → регистрация допустима.
    // (emailVerified=false — не авто-линкуем к чужому существующему аккаунту, но
    // для НОВОГО аккаунта этот email допустим как первичный, чужого не задеваем.)
    canRegister: true,
    authUrl: () => process.env.OAUTH_YANDEX_AUTH_URL || 'https://oauth.yandex.ru/authorize',
    tokenUrl: () => process.env.OAUTH_YANDEX_TOKEN_URL || 'https://oauth.yandex.ru/token',
    userinfoUrl: () => process.env.OAUTH_YANDEX_USERINFO_URL || 'https://login.yandex.ru/info?format=json',
    scope: 'login:email login:info',
    profile: (info) => ({
      id: String(info.id),
      email: info.default_email || info.emails?.[0] || null,
      // Яндекс не возвращает признак подтверждения email → не авто-линкуем к чужому аккаунту.
      emailVerified: false,
      name: info.real_name || info.display_name || info.login,
    }),
  },
  vk: {
    label: 'ВКонтакте',
    // ADR-034: ВК не гарантирует email → только привязка, не первичная регистрация.
    canRegister: false,
    authUrl: () => process.env.OAUTH_VK_AUTH_URL || 'https://id.vk.com/authorize',
    tokenUrl: () => process.env.OAUTH_VK_TOKEN_URL || 'https://id.vk.com/oauth2/auth',
    userinfoUrl: () => process.env.OAUTH_VK_USERINFO_URL || 'https://id.vk.com/oauth2/user_info',
    scope: 'email',
    profile: (info) => {
      const user = info.user || info;
      return {
        id: String(user.user_id || user.id),
        email: user.email || null,
        // VK не даёт признак подтверждения email через user_info → не авто-линкуем.
        emailVerified: false,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      };
    },
  },
  sber: {
    label: 'Сбер ID',
    // ADR-034: Сбер ID отдаёт верифицированный email → регистрация допустима.
    canRegister: true,
    authUrl: () => process.env.OAUTH_SBER_AUTH_URL || 'https://online.sberbank.ru/CSAFront/oidc/authorize.do',
    tokenUrl: () => process.env.OAUTH_SBER_TOKEN_URL || 'https://api.sberbank.ru/ru/prod/tokens/v2/oidc',
    userinfoUrl: () => process.env.OAUTH_SBER_USERINFO_URL || 'https://api.sberbank.ru/ru/prod/sberbankid/v2.1/userinfo',
    scope: 'openid email name',
    profile: (info) => ({
      id: String(info.sub),
      email: info.email,
      emailVerified: info.email_verified === true || info.email_verified === 'true',
      name: info.name || info.email,
    }),
  },
};

function credsFor(provider) {
  const key = provider.toUpperCase();
  return {
    clientId: process.env[`OAUTH_${key}_CLIENT_ID`] || '',
    clientSecret: process.env[`OAUTH_${key}_CLIENT_SECRET`] || '',
  };
}

export function isProviderEnabled(provider) {
  const creds = credsFor(provider);
  return Boolean(REGISTRY[provider] && creds.clientId && creds.clientSecret);
}

// ADR-034: может ли провайдер быть первичной регистрацией (даёт email), или он
// только для привязки к существующему аккаунту (Telegram/ВК — email не гарантируют).
export function providerCanRegister(provider) {
  return REGISTRY[provider]?.canRegister === true;
}

export function enabledProviders() {
  return Object.keys(REGISTRY)
    .filter(isProviderEnabled)
    .map((provider) => ({ provider, label: REGISTRY[provider].label }));
}

// US-16.1 (ADR-027): Telegram Login Widget — не authorization-code, а
// подписанные данные. Проверяем HMAC по схеме Telegram: secret = SHA256(токен
// бота), подпись = HMAC-SHA256(data_check_string, secret). Включается, если
// заданы токен и username бота.
export function isTelegramLoginEnabled() {
  return Boolean(
    (process.env.TELEGRAM_LOGIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN) && process.env.TELEGRAM_LOGIN_BOT_USERNAME,
  );
}

export function telegramLoginConfig() {
  return { botUsername: process.env.TELEGRAM_LOGIN_BOT_USERNAME || '' };
}

const TELEGRAM_AUTH_MAX_AGE_SECONDS = Number(process.env.TELEGRAM_LOGIN_MAX_AGE_SECONDS || 86400);

export function verifyTelegramLogin(params) {
  const token = process.env.TELEGRAM_LOGIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !params?.hash) {
    return null;
  }

  const { hash, ...rest } = params;
  const dataCheckString = Object.keys(rest)
    .filter((key) => rest[key] !== undefined && rest[key] !== '')
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('\n');

  const secret = createHash('sha256').update(token).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (!constantTimeEqual(expected, hash)) {
    return null;
  }

  // Подпись подделать нельзя, но старые данные могли утечь — ограничиваем возраст.
  const authDate = Number(rest.auth_date || 0);
  if (!authDate || Date.now() / 1000 - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
    return null;
  }

  return {
    id: String(rest.id),
    email: null,
    name: [rest.first_name, rest.last_name].filter(Boolean).join(' ') || rest.username || `Telegram ${rest.id}`,
  };
}

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState() {
  return randomBytes(24).toString('base64url');
}

export function redirectUri(provider, requestUrl) {
  const base = (process.env.OAUTH_REDIRECT_BASE || process.env.PUBLIC_APP_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
  return `${base}/api/auth/oauth/${provider}/callback`;
}

export function buildAuthorizeUrl(provider, { state, challenge, redirectUri: uri }) {
  const config = REGISTRY[provider];
  const { clientId } = credsFor(provider);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: uri,
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return `${config.authUrl()}?${params}`;
}

/**
 * Обмен кода на токен + получение профиля. Возвращает нормализованный профиль
 * {id, email, name}. Бросает при ошибке провайдера.
 */
export async function exchangeCodeForProfile(provider, { code, codeVerifier, redirectUri: uri }) {
  const config = REGISTRY[provider];
  const { clientId, clientSecret } = credsFor(provider);

  const tokenResponse = await fetch(config.tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: uri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    }),
  });
  const token = await tokenResponse.json().catch(() => null);

  if (!tokenResponse.ok || !token?.access_token) {
    throw new Error(token?.error_description || token?.error || `Не удалось обменять код (${tokenResponse.status})`);
  }

  const userinfoResponse = await fetch(config.userinfoUrl(), {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  });
  const info = await userinfoResponse.json().catch(() => null);

  if (!userinfoResponse.ok || !info) {
    throw new Error(`Не удалось получить профиль (${userinfoResponse.status})`);
  }

  const profile = config.profile(info);

  if (!profile.id) {
    throw new Error('Профиль провайдера без идентификатора');
  }

  return profile;
}
