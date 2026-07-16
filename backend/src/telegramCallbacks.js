import { createHash } from 'node:crypto';
import { query } from './db.js';
import { TASK_CALLBACK_PATTERN, answerTelegramCallback, clearTelegramMessageButtons, getTelegramUpdates } from './telegram.js';
import { handleBotMessage } from './telegramIntake.js';

// Разрешённые переходы по кнопкам (US-11.3): «Взять в работу» не воскрешает
// выполненную или скрытую задачу, «Выполнено» не трогает скрытую.
const ALLOWED_TRANSITIONS = {
  progress: ['extracted', 'confirmed', 'sent'],
  done: ['extracted', 'confirmed', 'sent', 'in_progress'],
};

const ACTION_STATUS = { progress: 'in_progress', done: 'done' };
const ACTION_REPLY = { progress: 'Задача взята в работу', done: 'Задача отмечена выполненной' };

function botKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Все боты, чьи нажатия надо слушать: боты пользователей из настроек + общий
 * из окружения. Токен один и тот же у нескольких пользователей — опрашивается
 * один раз (getUpdates c одним токеном из двух мест перебивали бы друг другу
 * offset и теряли нажатия).
 */
async function listBotTokens() {
  const result = await query(
    `select distinct telegram_config->>'botToken' as token from app_users
     where telegram_config->>'botToken' is not null and telegram_config->>'botToken' <> ''`,
  );
  const tokens = new Set(result.rows.map((row) => row.token));

  if (process.env.TELEGRAM_BOT_TOKEN) {
    tokens.add(process.env.TELEGRAM_BOT_TOKEN);
  }

  return [...tokens];
}

async function readCursor(key) {
  const result = await query('select last_update_id from telegram_bot_cursors where bot_key = $1', [key]);
  return result.rows[0] ? Number(result.rows[0].last_update_id) : 0;
}

async function saveCursor(key, lastUpdateId) {
  await query(
    `insert into telegram_bot_cursors (bot_key, last_update_id, updated_at)
     values ($1, $2, now())
     on conflict (bot_key) do update set last_update_id = excluded.last_update_id, updated_at = now()`,
    [key, lastUpdateId],
  );
}

/**
 * Обрабатывает одно нажатие. Владение проверяется по боту: задачу можно менять
 * только через бота её владельца (токен из настроек владельца записи или общий
 * из окружения) — иначе чужой бот с угаданным uuid двигал бы чужие задачи.
 */
async function applyCallback(botToken, callback) {
  const match = TASK_CALLBACK_PATTERN.exec(callback.data || '');

  if (!match) {
    return null;
  }

  const [, action, taskId] = match;
  const owner = await query(
    `select t.id, t.status, r.owner_id, u.telegram_config->>'botToken' as owner_bot_token
     from recording_tasks t
     join recordings r on r.id = t.recording_id
     left join app_users u on u.id = r.owner_id
     where t.id = $1`,
    [taskId],
  );
  const task = owner.rows[0];
  const ownerToken = task?.owner_bot_token || process.env.TELEGRAM_BOT_TOKEN || null;

  if (!task || ownerToken !== botToken) {
    return { reply: 'Задача не найдена' };
  }

  if (!ALLOWED_TRANSITIONS[action].includes(task.status)) {
    return { reply: 'Статус задачи уже изменился — обновите её в VoxMate' };
  }

  await query('update recording_tasks set status = $2, updated_at = now() where id = $1', [taskId, ACTION_STATUS[action]]);

  return {
    reply: ACTION_REPLY[action],
    // После «Выполнено» кнопки в сообщении больше не нужны.
    clearButtons: action === 'done' ? { chatId: callback.message?.chat?.id, messageId: callback.message?.message_id } : null,
  };
}

/**
 * Один проход поллера: для каждого бота забирает свежие callback_query и
 * применяет их. Сбой одного бота (протухший токен, сеть) не мешает остальным.
 */
export async function pollTelegramCallbacks() {
  const tokens = await listBotTokens();

  for (const token of tokens) {
    const key = botKey(token);

    try {
      const cursor = await readCursor(key);
      const updates = await getTelegramUpdates(token, cursor + 1);

      if (!Array.isArray(updates) || !updates.length) {
        continue;
      }

      for (const update of updates) {
        const callback = update.callback_query;

        if (callback) {
          try {
            const outcome = await applyCallback(token, callback);

            if (outcome) {
              await answerTelegramCallback(token, callback.id, outcome.reply);

              if (outcome.clearButtons?.chatId && outcome.clearButtons?.messageId) {
                await clearTelegramMessageButtons(token, outcome.clearButtons.chatId, outcome.clearButtons.messageId);
              }
            }
          } catch (error) {
            console.warn(`Telegram callback ${callback.id} failed: ${error.message}`);
          }
        }

        // US-14.1: тот же поллер обслуживает standalone-бота — голосовые,
        // файлы и ссылки в личных чатах. Ошибки приёма гасятся внутри.
        if (update.message) {
          await handleBotMessage(token, update.message);
        }
      }

      // Курсор двигается после обработки пачки: упади мы посреди неё, пачка
      // придёт заново — переходы статусов идемпотентны (повтор упрётся в
      // ALLOWED_TRANSITIONS и просто ответит «статус уже изменился»).
      await saveCursor(key, Math.max(...updates.map((update) => update.update_id)));
    } catch (error) {
      console.warn(`Telegram poll failed for bot ${key.slice(0, 8)}: ${error.message}`);
    }
  }
}
