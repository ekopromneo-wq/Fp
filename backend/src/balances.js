import { SPEECH2TEXT_API_URL } from './speech2textDiarizer.js';

const CHECK_TIMEOUT_MS = Number(process.env.BALANCE_CHECK_TIMEOUT_MS || 10000);
const SHOPOT_API_URL = process.env.SHOPOT_API_URL || 'https://api.shopot.ai';
const SHOPOT_DASHBOARD_URL = 'https://app.shopot.ai/account';
const OPENROUTER_DASHBOARD_URL = 'https://openrouter.ai/credits';
const SPEECH2TEXT_DASHBOARD_URL = 'https://speech2text.ru';

/**
 * Баланс OpenRouter — единственный из трёх, который отдаётся числом.
 * `total_credits` — сколько пополнено за всё время, `total_usage` — сколько
 * потрачено; остаток считаем сами.
 */
async function checkOpenRouter(apiKey) {
  const response = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);

  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid_key', message: 'Ключ отклонён' };
  }

  if (!response.ok) {
    return { status: 'error', message: body?.error?.message || `OpenRouter ответил ${response.status}` };
  }

  const total = Number(body?.data?.total_credits ?? 0);
  const used = Number(body?.data?.total_usage ?? 0);

  return {
    status: 'ok',
    amount: { remaining: Math.max(0, total - used), total, used, unit: 'USD' },
  };
}

/**
 * У Shopot баланса в API нет — публично живут только /v1/transcribe и
 * /v1/status/{id} (см. api.shopot.ai). Но проверку баланса и ключа их сервер
 * делает ДО разбора файла, поэтому запрос без файла — безопасный зонд: задача
 * не создаётся и минуты не списываются, а по тексту ответа видно, чего именно
 * не хватает. Числа минут узнать неоткуда, только «хватает / не хватает».
 */
async function checkShopot(apiKey) {
  const form = new FormData();
  form.append('language', process.env.SHOPOT_LANGUAGE || 'ru');

  const response = await fetch(`${SHOPOT_API_URL}/v1/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  const detail = String(body?.detail || body?.error || body?.message || '');

  if (/insufficient/i.test(detail) && /balance/i.test(detail)) {
    return { status: 'insufficient', message: 'Баланс исчерпан — сервис требует не меньше 60 минут на счету' };
  }

  if (/invalid.*api key/i.test(detail)) {
    return { status: 'invalid_key', message: 'Ключ отклонён' };
  }

  if (response.status >= 500) {
    return { status: 'error', message: `Shopot ответил ${response.status}` };
  }

  // Ключ приняли и на баланс не пожаловались — дальше сервер споткнулся уже об
  // отсутствие файла, что для зонда и есть успех.
  return { status: 'ok', message: 'Ключ принят, баланса хватает (сколько именно минут — сервис не сообщает)' };
}

/**
 * Speech2Text отдаёт баланс числом — /api/user/amounts:
 * `{"minutes":{"available":300,"used":0},"amount":0}`. Основная валюта
 * распознавания — минуты по тарифу; `amount` — рубли на лицевом счёте, с
 * которого доплачиваются задачи сверх тарифных минут (/price + /pay).
 * `total` считаем как available + used: отдельного «размера тарифа» в ответе
 * нет, а панели нужна база для индикатора «осталось мало».
 */
async function checkSpeech2Text(apiKey) {
  const response = await fetch(`${SPEECH2TEXT_API_URL}/api/user/amounts?api-key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);

  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid_key', message: 'Ключ отклонён' };
  }

  if (!response.ok) {
    return { status: 'error', message: body?.message || `Speech2Text ответил ${response.status}` };
  }

  const available = Number(body?.minutes?.available ?? 0);
  const used = Number(body?.minutes?.used ?? 0);
  const account = Number(body?.amount ?? 0);
  const accountNote = `На лицевом счёте ${account.toFixed(2)} ₽ — с него доплачиваются задачи сверх тарифных минут.`;

  return {
    status: available > 0 ? 'ok' : 'insufficient',
    amount: { remaining: available, total: available + used, used, unit: 'мин' },
    message: available > 0 ? accountNote : `Тарифные минуты исчерпаны — новые задачи встанут в паузу. ${accountNote}`,
  };
}

const SERVICES = [
  {
    service: 'openrouter',
    label: 'OpenRouter',
    note: 'Расшифровка, протоколы, задачи, определение имён спикеров',
    dashboardUrl: OPENROUTER_DASHBOARD_URL,
    resolveKey: () => process.env.OPENROUTER_API_KEY || '',
    check: checkOpenRouter,
  },
  {
    service: 'shopot',
    label: 'Shopot',
    note: 'Облачная диаризация — баланс в минутах',
    dashboardUrl: SHOPOT_DASHBOARD_URL,
    resolveKey: (config) => config.shopotApiKey || process.env.SHOPOT_API_KEY || '',
    check: checkShopot,
  },
  {
    service: 'speech2text',
    label: 'Speech2Text',
    note: 'Облачная диаризация',
    dashboardUrl: SPEECH2TEXT_DASHBOARD_URL,
    resolveKey: (config) => config.speech2textApiKey || process.env.SPEECH2TEXT_API_KEY || '',
    check: checkSpeech2Text,
  },
];

/**
 * Состояние счетов облачных сервисов (US: баланс на странице настроек).
 * Сервисы опрашиваются параллельно и независимо: недоступность одного не должна
 * прятать остальные, поэтому ошибка каждого приезжает в его же карточке.
 */
export async function collectServiceBalances(diarizationConfig = {}) {
  return Promise.all(
    SERVICES.map(async ({ service, label, note, dashboardUrl, resolveKey, check }) => {
      const base = { service, label, note, dashboardUrl, checkedAt: new Date().toISOString() };
      const apiKey = resolveKey(diarizationConfig);

      if (!apiKey) {
        return { ...base, configured: false, status: 'not_configured', message: 'Ключ не задан' };
      }

      try {
        return { ...base, configured: true, ...(await check(apiKey)) };
      } catch (error) {
        return {
          ...base,
          configured: true,
          status: 'error',
          message: error.name === 'TimeoutError' ? 'Сервис не ответил вовремя' : error.message || 'Не удалось проверить',
        };
      }
    }),
  );
}
