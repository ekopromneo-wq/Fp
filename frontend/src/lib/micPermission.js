// STG-004: общая логика запроса/диагностики доступа к микрофону. Раньше
// каждый вызывающий (useMicRecorder, VoiceInputButton, ProtocolView-надиктовка,
// MicrophoneSettingsPanel) независимо звал getUserMedia и различал только
// NotAllowedError — остальные ошибки (занят устройством, нет микрофона,
// небезопасный контекст) падали в сырое error.message. Здесь — единая карта
// сообщений и опциональная проверка Permissions API до getUserMedia, чтобы не
// дёргать повторный запрос, если доступ уже заблокирован навсегда.

/**
 * @returns {Promise<'granted'|'denied'|'prompt'|'unsupported'>}
 */
export async function checkMicPermissionState() {
  if (!navigator.permissions?.query) {
    return 'unsupported';
  }

  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    // Некоторые браузеры (Safari) бросают исключение на незнакомое имя разрешения.
    return 'unsupported';
  }
}

const ERROR_MESSAGES = {
  NotAllowedError: 'Доступ к микрофону запрещён. Разрешите доступ в настройках браузера.',
  PermissionDeniedError: 'Доступ к микрофону запрещён. Разрешите доступ в настройках браузера.',
  NotFoundError: 'Микрофон не найден. Подключите микрофон и попробуйте снова.',
  DevicesNotFoundError: 'Микрофон не найден. Подключите микрофон и попробуйте снова.',
  NotReadableError: 'Микрофон занят другим приложением или недоступен на уровне системы.',
  TrackStartError: 'Микрофон занят другим приложением или недоступен на уровне системы.',
  OverconstrainedError: 'Выбранный микрофон недоступен — используется микрофон по умолчанию.',
  SecurityError: 'Доступ к микрофону заблокирован настройками безопасности сайта.',
  AbortError: 'Не удалось получить доступ к микрофону — попробуйте ещё раз.',
  TypeError: 'Запись с микрофона недоступна в этом контексте (нужен HTTPS).',
};

export function describeMicError(error) {
  return ERROR_MESSAGES[error?.name] || error?.message || 'Не удалось получить доступ к микрофону';
}

/**
 * @param {string} [deviceId]
 * @returns {Promise<MediaStream>}
 */
export async function requestMicStream(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (error) {
    if (deviceId && error.name === 'OverconstrainedError') {
      // Сохранённое устройство больше недоступно (отключено и т.п.) —
      // откатываемся на микрофон по умолчанию вместо отказа в записи.
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}
