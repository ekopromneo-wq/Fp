import { buildEmailContent } from './email.js';
import { PAYLOAD_KINDS, PermanentSendError } from './sending.js';

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

async function sendTelegramMessage(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    const message = body?.description || `Telegram sendMessage failed with ${response.status}`;

    // 400/403 — чат не найден, бот заблокирован, текст не принят: повтор ничего
    // не изменит. 429/5xx — временное, их повторяем (US-11.1).
    if (response.status === 400 || response.status === 403) {
      throw new PermanentSendError(message);
    }

    throw new Error(message);
  }

  return body.result;
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
