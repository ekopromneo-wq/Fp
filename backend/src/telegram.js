import { buildEmailContent } from './email.js';
import { PAYLOAD_KINDS, PermanentSendError } from './sending.js';

// Переопределяется в тестах: боевой Bot API не позволяет проверить отправку и
// нажатия inline-кнопок без настоящего бота и живого получателя.
const TELEGRAM_API_URL = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

const TELEGRAM_MESSAGE_LIMIT = 4000;

function getTelegramConfig(input = {}) {
  const botToken = input.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = input.chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID;

  if (!botToken || !chatId) {
    throw new PermanentSendError('Telegram не настроен — укажите бота и чат в настройках');
  }

  return { botToken, chatId };
}

function splitIntoChunks(text, maxLength) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length > maxLength) {
      if (current) {
        chunks.push(current);
      }

      current = line.length > maxLength ? line.slice(0, maxLength) : line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function callTelegram(botToken, method, payload) {
  const response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    const message = body?.description || `Telegram ${method} failed with ${response.status}`;

    // 400/403 — чат не найден, бот заблокирован, текст не принят: повтор ничего
    // не изменит. 429/5xx — временное, их повторяем (US-11.1).
    if (response.status === 400 || response.status === 403) {
      throw new PermanentSendError(message);
    }

    throw new Error(message);
  }

  return body.result;
}

export function sendTelegramMessage(botToken, chatId, text, extra = {}) {
  return callTelegram(botToken, 'sendMessage', { chat_id: chatId, text, ...extra });
}

// Длинный текст (протокол, результат бота) уходит несколькими сообщениями.
export async function sendTelegramText(botToken, chatId, text) {
  for (const chunk of splitIntoChunks(text, TELEGRAM_MESSAGE_LIMIT)) {
    await sendTelegramMessage(botToken, chatId, chunk);
  }
}

/**
 * Скачивание присланного боту файла (US-14.1): getFile выдаёт путь, сам файл
 * отдаётся с file-эндпоинта. Bot API отдаёт ботам файлы только до ~20 МБ —
 * это тот самый «лимит Telegram» из критерия приёмки.
 */
export async function downloadTelegramFile(botToken, fileId) {
  const file = await callTelegram(botToken, 'getFile', { file_id: fileId });
  const filePath = file?.file_path;

  if (!filePath) {
    throw new Error('Telegram getFile вернул ответ без file_path');
  }

  const response = await fetch(`${TELEGRAM_API_URL}/file/bot${botToken}/${filePath}`);

  if (!response.ok) {
    throw new Error(`Telegram file download failed with ${response.status}`);
  }

  return { buffer: Buffer.from(await response.arrayBuffer()), filePath };
}

// Short "your recording is ready/failed" notification, distinct from
// sendRecordingTelegram's full protocol/summary dump.
export async function sendNotificationTelegram(telegramConfig, text) {
  const config = getTelegramConfig(telegramConfig);
  return sendTelegramMessage(config.botToken, config.chatId, text);
}

export async function sendRecordingTelegram(recording, input = {}, telegramConfig = {}) {
  const config = getTelegramConfig({ ...telegramConfig, chatId: input.chatId || telegramConfig.chatId });
  const payloadKind = PAYLOAD_KINDS.includes(input.payloadKind) ? input.payloadKind : 'protocol';
  const { text } = buildEmailContent(recording, input.message, payloadKind);
  const chunks = splitIntoChunks(text, TELEGRAM_MESSAGE_LIMIT);
  const messages = [];

  for (const chunk of chunks) {
    messages.push(await sendTelegramMessage(config.botToken, config.chatId, chunk));
  }

  return {
    chatId: config.chatId,
    messageIds: messages.map((message) => message.message_id),
    chunkCount: chunks.length,
  };
}

// callback_data inline-кнопок: "task:<действие>:<id задачи>". Telegram
// ограничивает callback_data 64 байтами — "task:progress:" + uuid(36) = 50.
export const TASK_CALLBACK_PATTERN = /^task:(done|progress):([0-9a-f-]{36})$/;

/**
 * Личное сообщение исполнителю с одной задачей (US-11.3): текст + inline-кнопки
 * «Взять в работу» / «Выполнено». chatId приходит из контакта — общий чат из
 * настроек тут не годится, задача адресная.
 */
export async function sendTaskTelegram(telegramConfig, chatId, recording, task) {
  const botToken = telegramConfig?.botToken || process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new PermanentSendError('Telegram не настроен — укажите бота в настройках');
  }

  if (!String(chatId || '').trim()) {
    throw new PermanentSendError('У контакта не привязан Telegram');
  }

  const text = [
    `Задача из встречи «${recording.title}»`,
    '',
    task.description,
    '',
    `Срок: ${task.dueText || 'не указан'}`,
  ].join('\n');

  const message = await sendTelegramMessage(botToken, String(chatId).trim(), text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Взять в работу', callback_data: `task:progress:${task.id}` },
          { text: 'Выполнено', callback_data: `task:done:${task.id}` },
        ],
      ],
    },
  });

  return { chatId: String(chatId).trim(), messageId: message.message_id };
}

/**
 * Помощники поллера нажатий (worker.js): вебхук на пользовательских ботах в
 * MVP не поднимаем — каждому боту пришлось бы регистрировать свой публичный
 * URL, а getUpdates работает из коробки.
 */
export function getTelegramUpdates(botToken, offset) {
  return callTelegram(botToken, 'getUpdates', {
    offset,
    timeout: 0,
    // callback_query — кнопки задач (US-11.3), message — standalone-бот (US-14.1).
    allowed_updates: ['callback_query', 'message'],
  });
}

export function answerTelegramCallback(botToken, callbackQueryId, text) {
  return callTelegram(botToken, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// После отметки кнопки убираем: повторное нажатие «Выполнено» на выполненной
// задаче только путает.
export function clearTelegramMessageButtons(botToken, chatId, messageId) {
  return callTelegram(botToken, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}
