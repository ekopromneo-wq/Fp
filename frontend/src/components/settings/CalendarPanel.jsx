import { useEffect, useState } from 'react';
import { apiBaseUrl, apiFetch } from '../../lib/api.js';

/**
 * Календарь Outlook / Microsoft 365 (US-16.5). Подключение — редиректом на
 * Microsoft; статус и переподключение — здесь. Показывается, только если
 * календарь настроен на сервере (заданы MS OAuth-креды).
 */
export default function CalendarPanel({ setStatus }) {
  const [state, setState] = useState({ enabled: false, connection: null, loaded: false });

  async function load() {
    try {
      const response = await apiFetch('/api/calendar/status');
      const data = await response.json();
      if (response.ok) {
        setState({ enabled: data.enabled, connection: data.connection, loaded: true });
      }
    } catch {
      setState((current) => ({ ...current, loaded: true }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function disconnect() {
    const response = await apiFetch('/api/calendar/connection', { method: 'DELETE' });
    if (response.ok) {
      setStatus('Календарь отключён');
      load();
    }
  }

  // Пока сервер без MS-кредов — панель не мешаемся, скрываемся.
  if (!state.loaded || !state.enabled) {
    return null;
  }

  const status = state.connection?.status;

  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Календарь</p>
          <h2>Outlook / Microsoft 365</h2>
        </div>
      </div>

      {status === 'connected' ? (
        <>
          <p className="calendar-status calendar-connected">Подключён — напомним начать запись за 15 минут до встречи.</p>
          <button className="button button-danger" type="button" onClick={disconnect}>
            Отключить календарь
          </button>
        </>
      ) : status === 'needs_reconnect' ? (
        <>
          <p className="calendar-status calendar-reconnect">Доступ к календарю истёк — переподключите, чтобы снова получать напоминания.</p>
          <a className="button button-primary" href={`${apiBaseUrl}/api/calendar/microsoft/connect`}>
            Переподключить
          </a>
        </>
      ) : (
        <>
          <p className="muted-text">Подключите календарь, чтобы приложение напоминало начать запись перед встречей.</p>
          <a className="button button-primary" href={`${apiBaseUrl}/api/calendar/microsoft/connect`}>
            Подключить Outlook
          </a>
        </>
      )}
    </section>
  );
}
