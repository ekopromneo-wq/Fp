// US-15.1: технический журнал подключений бота-участника конференций.
// Неизменяемый append-only лог. Пишут обе стороны: бэкенд (запрос входа, стоп,
// callback, ингест/поллинг) и сам recorder-bot (отчёты о join/зале ожидания/
// разрыве/переподключении/конце через internal-эндпоинт). Fire-and-forget —
// журнал никогда не должен ломать сам сценарий записи.

import { query } from './db.js';

// Разрешённый словарь событий — защита от опечаток и мусора из контейнера.
export const BOT_EVENTS = Object.freeze([
  'join_requested', // бэкенд инициировал вход
  'join_accepted', // провайдер/бот принял задачу
  'join_failed', // не удалось инициировать вход
  'joining', // recorder-bot: открывает страницу конференции
  'waiting_room', // recorder-bot: в зале ожидания
  'in_meeting', // recorder-bot: вошёл, идёт запись
  'rtc_disconnected', // recorder-bot: разрыв WebRTC
  'rtc_reconnected', // recorder-bot: соединение восстановилось
  'stopped_by_user', // владелец остановил
  'callback_received', // бэкенд получил финальный callback recorder-bot
  'ended', // recorder-bot: встреча завершилась (reason в detail)
  'ended_error', // завершилось ошибкой
  'ingested', // Speech2Text: транскрипт получен и внесён
  'poll_failed', // Speech2Text: ошибка опроса задачи
  'paused', // Speech2Text: задача приостановлена — исчерпан лимит минут по тарифу
]);

const ALLOWED = new Set(BOT_EVENTS);

export async function logBotEvent(recordingId, { engine = null, platform = null, event, detail = {} } = {}) {
  if (!recordingId || !event) {
    return;
  }

  if (!ALLOWED.has(event)) {
    console.warn(`bot_connection_events: неизвестное событие "${event}" — пропущено`);
    return;
  }

  try {
    await query(
      `insert into bot_connection_events (recording_id, engine, platform, event, detail)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [recordingId, engine, platform, event, JSON.stringify(detail || {})],
    );
  } catch (error) {
    console.warn(`bot_connection_events: не удалось записать "${event}":`, error.message);
  }
}

export async function getBotEvents(recordingId) {
  const result = await query(
    `select event, engine, platform, detail, created_at
     from bot_connection_events
     where recording_id = $1
     order by created_at asc`,
    [recordingId],
  );

  return result.rows;
}

export function isKnownBotEvent(event) {
  return ALLOWED.has(event);
}
