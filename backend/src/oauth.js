import { createHash, randomBytes } from 'node:crypto';

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
    authUrl: () => process.env.OAUTH_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => process.env.OAUTH_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    userinfoUrl: () => process.env.OAUTH_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    profile: (info) => ({ id: String(info.sub), email: info.email, name: info.name || info.email }),
  },
  yandex: {
    label: 'Яндекс',
    authUrl: () => process.env.OAUTH_YANDEX_AUTH_URL || 'https://oauth.yandex.ru/authorize',
    tokenUrl: () => process.env.OAUTH_YANDEX_TOKEN_URL || 'https://oauth.yandex.ru/token',
    userinfoUrl: () => process.env.OAUTH_YANDEX_USERINFO_URL || 'https://login.yandex.ru/info?format=json',
    scope: 'login:email login:info',
    profile: (info) => ({
      id: String(info.id),
      email: info.default_email || info.emails?.[0] || null,
      name: info.real_name || info.display_name || info.login,
    }),
  },
  vk: {
    label: 'ВКонтакте',
    authUrl: () => process.env.OAUTH_VK_AUTH_URL || 'https://id.vk.com/authorize',
    tokenUrl: () => process.env.OAUTH_VK_TOKEN_URL || 'https://id.vk.com/oauth2/auth',
    userinfoUrl: () => process.env.OAUTH_VK_USERINFO_URL || 'https://id.vk.com/oauth2/user_info',
    scope: 'email',
    profile: (info) => {
      const user = info.user || info;
      return {
        id: String(user.user_id || user.id),
        email: user.email || null,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      };
    },
  },
  sber: {
    label: 'Сбер ID',
    authUrl: () => process.env.OAUTH_SBER_AUTH_URL || 'https://online.sberbank.ru/CSAFront/oidc/authorize.do',
    tokenUrl: () => process.env.OAUTH_SBER_TOKEN_URL || 'https://api.sberbank.ru/ru/prod/tokens/v2/oidc',
    userinfoUrl: () => process.env.OAUTH_SBER_USERINFO_URL || 'https://api.sberbank.ru/ru/prod/sberbankid/v2.1/userinfo',
    scope: 'openid email name',
    profile: (info) => ({ id: String(info.sub), email: info.email, name: info.name || info.email }),
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

export function enabledProviders() {
  return Object.keys(REGISTRY)
    .filter(isProviderEnabled)
    .map((provider) => ({ provider, label: REGISTRY[provider].label }));
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
