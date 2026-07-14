import { buildEmailContent } from './email.js';

const TELEGRAM_MESSAGE_LIMIT = 4000;

function getTelegramConfig(input = {}) {
  const botToken = input.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = input.chatId || process.env.TELEGRAM_DEFAULT_CHAT_ID;

  if (!botToken || !chatId) {
    throw new Error('Telegram is not configured');
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
    throw new Error(body?.description || `Telegram sendMessage failed with ${response.status}`);
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
  const { text } = buildEmailContent(recording, input.message);
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
