import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { formatDate } from '../lib/format.js';

// US-15.1: технический журнал подключений бота-участника. Читаемые метки для
// событий из bot_connection_events (см. backend/src/botLog.js).
const EVENT_LABELS = {
  join_requested: 'Запрошен вход бота',
  join_accepted: 'Бот принял задачу',
  join_failed: 'Не удалось начать вход',
  joining: 'Бот открывает конференцию',
  waiting_room: 'В зале ожидания',
  in_meeting: 'Бот вошёл — идёт запись',
  rtc_disconnected: 'Разрыв связи',
  rtc_reconnected: 'Связь восстановлена',
  stopped_by_user: 'Остановлено пользователем',
  callback_received: 'Получен результат от бота',
  ended: 'Встреча завершилась',
  ended_error: 'Завершилось ошибкой',
  ingested: 'Транскрипт получен',
  poll_failed: 'Ошибка опроса задачи',
};

export default function BotConnectionLog({ recordingId, status }) {
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);

  // Перечитываем при смене статуса записи — новые события обычно приходят вместе
  // с переходами (queued→processing→done/failed). Не realtime, но покрывает
  // жизненный цикл.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch(`/api/recordings/${recordingId}/bot-events`);

        if (!response.ok) {
          return;
        }

        const data = await response.json();

        if (!cancelled) {
          setEvents(data.events || []);
          setLoaded(true);
        }
      } catch {
        // Журнал — вспомогательная информация, его сбой не должен мешать деталям.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordingId, status]);

  if (!loaded || events.length === 0) {
    return null;
  }

  return (
    <section className="detail-section bot-connection-log">
      <h3>Журнал подключений бота</h3>
      <ul className="bot-event-list">
        {events.map((item, index) => {
          const detail = item.detail || {};
          const extra = detail.error || detail.reason || detail.state || null;

          return (
            <li key={index} className={`bot-event bot-event-${item.event}`}>
              <span className="bot-event-time">{formatDate(item.created_at)}</span>
              <span className="bot-event-label">{EVENT_LABELS[item.event] || item.event}</span>
              {extra ? <span className="bot-event-detail">{extra}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
