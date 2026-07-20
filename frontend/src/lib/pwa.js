// ADR-035 §4.5 — kill-switch: аварийный сброс битого Service Worker.
// Снимаем регистрацию всех SW и чистим наши кэши (неймспейс cacheId 'stenogram'
// из vite.config.js), затем перезагружаем страницу на «голую» сеть. Защищено от
// петли перезагрузок флагом в sessionStorage: сброс — не более одного раза за
// вкладку/сессию (серверный флаг остаётся поднятым, пока ops его не снимет).

const KILL_SWITCH_FLAG = 'stenogram-killswitch-done';

function alreadyResetThisSession() {
  try {
    return sessionStorage.getItem(KILL_SWITCH_FLAG) === '1';
  } catch {
    // Приватный режим/недоступное хранилище — считаем, что не сбрасывали.
    return false;
  }
}

function markResetThisSession() {
  try {
    sessionStorage.setItem(KILL_SWITCH_FLAG, '1');
  } catch {
    // Не критично: без флага возможен один лишний цикл, но не бесконечный —
    // после unregister на следующей загрузке SW уже нет.
  }
}

// Возвращает true, если инициирована перезагрузка (был снят живой SW).
export async function hardResetServiceWorker() {
  if (alreadyResetThisSession()) {
    return false;
  }

  let hadServiceWorker = false;

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      hadServiceWorker = registrations.length > 0;
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.includes('stenogram')).map((key) => caches.delete(key)),
      );
    }
  } catch {
    // Сброс best-effort — даже частичный лучше, чем залипшая битая сборка.
  }

  markResetThisSession();

  if (hadServiceWorker) {
    window.location.reload();
    return true;
  }

  return false;
}
