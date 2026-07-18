export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
export const demoEmail = import.meta.env.VITE_DEMO_EMAIL || 'demo@voxmate.local';
export const demoPassword = import.meta.env.VITE_DEMO_PASSWORD || 'voxmate123';

export function apiFetch(path, options = {}) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
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
