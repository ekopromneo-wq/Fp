export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
export const demoEmail = import.meta.env.VITE_DEMO_EMAIL || 'demo@voxmate.local';
export const demoPassword = import.meta.env.VITE_DEMO_PASSWORD || 'voxmate123';

// ADR-035: версия сборки клиента, вшитая на этапе билда (см. define в
// vite.config.js). Шлём её в заголовке на каждый запрос — сервер по ней решает,
// совместим ли контракт (§4.4). В тестовом окружении define может отсутствовать.
// eslint-disable-next-line no-undef
export const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : '0';

// Событие, по которому PwaUpdatePrompt (ADR-035) показывает «обновите приложение»
// и триггерит обновление Service Worker, когда сервер ответил 426 (клиент устарел).
export const CLIENT_OUTDATED_EVENT = 'app:client-outdated';

function notifyClientOutdated(detail) {
  try {
    window.dispatchEvent(new CustomEvent(CLIENT_OUTDATED_EVENT, { detail }));
  } catch {
    // Событийная шина не критична — сам запрос уже завершён.
  }
}

export async function apiFetch(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-Client-Version': buildVersion,
      ...(options.headers || {}),
    },
  });

  // §4.4: несовместимая версия контракта. Сообщаем UI, но возвращаем ответ как
  // есть — вызывающий код сам решает, что делать с неуспехом.
  if (response.status === 426) {
    notifyClientOutdated({ status: 426, path });
  }

  return response;
}

// ADR-035 §4.5: узнать у сервера про kill-switch и минимальную версию клиента.
// Возвращает { buildVersion, minClientVersion, killSwitch } или null при ошибке
// сети (не мешаем работе офлайн — проверка best-effort).
export async function fetchAppRuntime() {
  try {
    const response = await apiFetch('/api/app/runtime');

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

export function getAudioUrl(recording) {
  return recording?.storageKey ? `${apiBaseUrl}/api/recordings/${recording.id}/audio` : '';
}

/**
 * Продуктовая аналитика (NFR §9): fire-and-forget отправка события. Разрешены
 * только события из белого списка на сервере (tasks_opened, offline_recovery).
 * Ошибки глотаем — аналитика не должна мешать пользователю. Только метаданные,
 * без содержимого встреч (152-ФЗ).
 */
export function track(event, props = {}) {
  try {
    apiFetch('/api/analytics/track', { method: 'POST', body: JSON.stringify({ event, props }) }).catch(() => {});
  } catch {
    // сеть/сериализация не должны влиять на UX
  }
}

export function isProcessingStatus(status) {
  return status === 'queued' || status === 'processing' || status === 'transcribing' || status === 'summarizing';
}
