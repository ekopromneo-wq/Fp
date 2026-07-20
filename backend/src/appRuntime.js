// ADR-035: обновление/кэширование PWA — серверная часть.
// Клиент шлёт версию сборки в заголовке X-Client-Version (эпоха-секунды билда).
// Сервер даёт две вещи:
//   1) гейт версии контракта: если задан MIN_CLIENT_VERSION и клиент ниже —
//      отвечаем 426, приложение показывает «обновите приложение» и триггерит
//      обновление Service Worker (§4.4);
//   2) GET /api/app/runtime — источник правды для клиента: минимальная версия,
//      kill-switch (аварийный сброс битого SW, §4.5) и версия серверной сборки.
// Заголовок необязателен: клиенты без него проходят, чтобы выкат не ломал всех
// разом — старые версии API держатся совместимыми на время выката (§4.4).

const CLIENT_VERSION_HEADER = 'x-client-version';
const RUNTIME_PATH = '/api/app/runtime';

function parseVersion(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Читается на каждый запрос, а не один раз при старте: ops может выставить
// kill-switch/минимальную версию в окружении и перезапустить только клиентов,
// не пересобирая образ (env меняется деплоем — процесс всё равно поднимается).
export function getRuntimeConfig() {
  return {
    // Версия серверной сборки — для диагностики/логов, гейтом не является.
    buildVersion: parseVersion(process.env.SERVER_BUILD_VERSION),
    // Клиенты ниже этой версии несовместимы. По умолчанию (null) гейта нет.
    minClientVersion: parseVersion(process.env.MIN_CLIENT_VERSION),
    // Аварийный сброс битого Service Worker у всех клиентов.
    killSwitch: process.env.PWA_KILL_SWITCH === '1',
  };
}

export function registerAppRuntimeRoutes(app) {
  // Гейт версии контракта. Регистрируется до остальных /api-роутов, чтобы
  // несовместимый клиент не доходил до бизнес-логики со старым контрактом.
  app.use('/api/*', async (c, next) => {
    // Сам рантайм-эндпоинт не гейтим: клиент должен уметь узнать про
    // kill-switch/минимальную версию, даже будучи «просроченным».
    if (c.req.path === RUNTIME_PATH) {
      return next();
    }

    const { minClientVersion } = getRuntimeConfig();

    if (minClientVersion !== null) {
      const clientVersion = parseVersion(c.req.header(CLIENT_VERSION_HEADER));

      // Блокируем, только если клиент прислал версию И она ниже минимума.
      // Отсутствие заголовка не блокируем (см. шапку файла).
      if (clientVersion !== null && clientVersion < minClientVersion) {
        return c.json({ error: 'client_outdated', minClientVersion }, 426);
      }
    }

    return next();
  });

  app.get(RUNTIME_PATH, (c) => c.json(getRuntimeConfig()));
}
