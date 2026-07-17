import { createHash, randomBytes } from 'node:crypto';
import { query } from './db.js';
import { attachRecordingAudio, createRecording, enqueueRecording, getRecording } from './recordings.js';
import { downloadTelegramFile, sendTelegramText, sendTelegramMessage } from './telegram.js';

// Bot API отдаёт ботам файлы только до 20 МБ — критерий приёмки US-14.1
// («файл превышает лимит Telegram → бот сообщает»).
const TELEGRAM_BOT_FILE_LIMIT_BYTES = Number(process.env.TELEGRAM_BOT_FILE_LIMIT_BYTES || 20 * 1024 * 1024);
// Файл по прямой ссылке качаем сами — лимит наш, не телеграмный.
const URL_DOWNLOAD_LIMIT_BYTES = Number(process.env.TELEGRAM_URL_DOWNLOAD_LIMIT_BYTES || 200 * 1024 * 1024);
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

const HELP_TEXT = [
  'Пришлите голосовое, аудио, видео или прямую ссылку на файл — я расшифрую встречу и верну протокол с задачами.',
  'Работает без установки приложения.',
].join('\n');

export function botKeyFor(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Код привязки чата к аккаунту (US-14.1 «связка с аккаунтом — авторизация»).
 * Выдаётся авторизованному пользователю в приложении, живёт 15 минут, один
 * активный код на пользователя.
 */
export async function createTelegramLinkCode(userId) {
  // A-Z без похожих на цифры букв + цифры: код диктуют и набирают руками.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');

  await query('delete from telegram_link_codes where user_id = $1 or expires_at < now()', [userId]);
  const result = await query(
    `insert into telegram_link_codes (code, user_id, expires_at)
     values ($1, $2, now() + interval '15 minutes')
     returning code, expires_at`,
    [code, userId],
  );

  return { code: result.rows[0].code, expiresAt: result.rows[0].expires_at, ttlMs: LINK_CODE_TTL_MS };
}

async function resolveLinkedUser(botKey, chatId) {
  const result = await query('select user_id from telegram_chat_links where bot_key = $1 and chat_id = $2', [
    botKey,
    String(chatId),
  ]);
  return result.rows[0]?.user_id || null;
}

async function tryLinkByCode(botKey, chatId, text) {
  // «/start КОД», просто «КОД», в любом регистре.
  const candidate = String(text || '').replace(/^\/start/i, '').trim().toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(candidate)) {
    return null;
  }

  const code = await query('delete from telegram_link_codes where code = $1 and expires_at > now() returning user_id', [
    candidate,
  ]);

  if (!code.rowCount) {
    return null;
  }

  const userId = code.rows[0].user_id;
  await query(
    `insert into telegram_chat_links (bot_key, chat_id, user_id)
     values ($1, $2, $3)
     on conflict (bot_key, chat_id) do update set user_id = excluded.user_id, created_at = now()`,
    [botKey, String(chatId), userId],
  );

  return userId;
}

/**
 * Вложение сообщения, пригодное для расшифровки. voice/audio/video/video_note —
 * очевидные; document берём только с аудио/видео mime-типом, чтобы бот не
 * пытался «расшифровать» PDF.
 */
function extractMediaMeta(message) {
  const voice = message.voice;
  if (voice) {
    return { fileId: voice.file_id, fileSize: voice.file_size, filename: 'voice-message.oga', mimeType: voice.mime_type || 'audio/ogg' };
  }

  const audio = message.audio;
  if (audio) {
    return {
      fileId: audio.file_id,
      fileSize: audio.file_size,
      filename: audio.file_name || 'audio.mp3',
      mimeType: audio.mime_type || 'audio/mpeg',
    };
  }

  const video = message.video || message.video_note;
  if (video) {
    return {
      fileId: video.file_id,
      fileSize: video.file_size,
      filename: video.file_name || 'video.mp4',
      mimeType: video.mime_type || 'video/mp4',
    };
  }

  const document = message.document;
  if (document && /^(audio|video)\//.test(document.mime_type || '')) {
    return {
      fileId: document.file_id,
      fileSize: document.file_size,
      filename: document.file_name || 'file.bin',
      mimeType: document.mime_type,
    };
  }

  return null;
}

/**
 * Создаёт запись из скачанного буфера и ставит в очередь обработки — ровно тот
 * же путь, что и загрузка из приложения (attachRecordingAudio + enqueue),
 * поэтому история бота автоматически видна в приложении (US-14.1
 * «синхронизация истории бота с приложением»).
 */
async function ingestBuffer(userId, buffer, filename, mimeType, title) {
  const recording = await createRecording({ title, source: 'telegram_bot' }, userId);
  const file = {
    name: filename,
    type: mimeType,
    arrayBuffer: async () => buffer,
  };

  await attachRecordingAudio(recording.id, file, userId);
  await enqueueRecording(recording.id, userId);

  return recording;
}

async function handleMediaMessage(botToken, userId, chatId, message, media) {
  if (media.fileSize && media.fileSize > TELEGRAM_BOT_FILE_LIMIT_BYTES) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `Файл слишком большой: Telegram отдаёт ботам файлы только до ${Math.round(TELEGRAM_BOT_FILE_LIMIT_BYTES / 1024 / 1024)} МБ. Загрузите его через приложение — там лимита Telegram нет.`,
    );
    return;
  }

  // Спека: подтверждаем получение → сообщаем об обработке.
  await sendTelegramMessage(botToken, chatId, 'Получил! Скачиваю и отправляю в обработку.');

  const { buffer } = await downloadTelegramFile(botToken, media.fileId);
  const title = media.filename.replace(/\.[^.]+$/, '') || `Из Telegram ${new Date().toLocaleDateString('ru-RU')}`;
  await ingestBuffer(userId, buffer, media.filename, media.mimeType, title);

  await sendTelegramMessage(botToken, chatId, 'В обработке. Пришлю протокол и задачи сюда, как будет готово.');
}

async function handleUrlMessage(botToken, userId, chatId, url) {
  await sendTelegramMessage(botToken, chatId, 'Получил ссылку! Скачиваю файл.');

  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });

  if (!response.ok) {
    await sendTelegramMessage(botToken, chatId, `Не удалось скачать по ссылке (ответ ${response.status}).`);
    return;
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);

  if (declaredSize > URL_DOWNLOAD_LIMIT_BYTES) {
    await sendTelegramMessage(botToken, chatId, 'Файл по ссылке слишком большой — загрузите его через приложение.');
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > URL_DOWNLOAD_LIMIT_BYTES) {
    await sendTelegramMessage(botToken, chatId, 'Файл по ссылке слишком большой — загрузите его через приложение.');
    return;
  }

  const pathname = new URL(url).pathname;
  const filename = decodeURIComponent(pathname.split('/').pop() || '') || 'audio-from-link';
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  await ingestBuffer(userId, buffer, filename, mimeType, filename.replace(/\.[^.]+$/, '') || 'Запись по ссылке');

  await sendTelegramMessage(botToken, chatId, 'В обработке. Пришлю протокол и задачи сюда, как будет готово.');
}

/**
 * Входящее сообщение боту (US-14.1). Вызывается поллером воркера. Только личные
 * чаты — групповые по спеке следующий этап.
 */
export async function handleBotMessage(botToken, message) {
  if (message?.chat?.type !== 'private') {
    return;
  }

  const botKey = botKeyFor(botToken);
  const chatId = message.chat.id;

  try {
    // Код привязки пробуем первым, даже если чат уже привязан: так человек
    // может пересвязать чат с другим аккаунтом, прислав свежий код.
    const relinked = await tryLinkByCode(botKey, chatId, message.text);

    if (relinked) {
      await sendTelegramMessage(botToken, chatId, `Чат привязан к аккаунту.\n\n${HELP_TEXT}`);
      return;
    }

    const userId = await resolveLinkedUser(botKey, chatId);

    if (!userId) {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Чат не привязан к аккаунту Stenogram. Откройте настройки приложения → Telegram → «Привязать чат» и пришлите мне код.',
      );
      return;
    }

    const media = extractMediaMeta(message);

    if (media) {
      await handleMediaMessage(botToken, userId, chatId, message, media);
      return;
    }

    const urlMatch = String(message.text || '').match(/https?:\/\/\S+/);

    if (urlMatch) {
      await handleUrlMessage(botToken, userId, chatId, urlMatch[0]);
      return;
    }

    await sendTelegramMessage(botToken, chatId, HELP_TEXT);
  } catch (error) {
    console.warn(`Telegram intake failed for chat ${chatId}: ${error.message}`);

    try {
      await sendTelegramMessage(botToken, chatId, 'Не получилось принять запись — попробуйте ещё раз или загрузите через приложение.');
    } catch {
      // Чат недоступен — уже нечем помочь.
    }
  }
}

/**
 * Результат обработки — обратно в чат (US-14.1: «бот возвращает протокол и
 * список задач»). Формат простой: резюме, решения, задачи и ссылка на полную
 * версию в приложении.
 */
function buildResultText(recording) {
  const lines = [`Готово: «${recording.title}»`, ''];

  if (recording.summary?.summary) {
    lines.push('Резюме:', recording.summary.summary, '');
  }

  const decisions = (recording.summary?.protocol?.decisions || [])
    .map((item) => (typeof item === 'string' ? item : item?.text))
    .filter(Boolean);

  if (decisions.length) {
    lines.push('Решения:');
    decisions.forEach((decision) => lines.push(`— ${decision}`));
    lines.push('');
  }

  const tasks = recording.tasks || [];

  if (tasks.length) {
    lines.push('Задачи:');
    tasks.forEach((task) => lines.push(`— ${task.assignee || '?'} | ${task.dueText || 'срок не указан'} | ${task.description}`));
  } else {
    lines.push('Задач не найдено.');
  }

  if (process.env.PUBLIC_APP_URL) {
    lines.push('', `Полная версия и правки: ${process.env.PUBLIC_APP_URL}`);
  }

  return lines.join('\n');
}

/**
 * Отдаёт результат (или сообщение о сбое) в привязанный чат владельца.
 * Вызывается из общего уведомительного канала на done/failed — только для
 * записей, пришедших через бота.
 */
export async function notifyTelegramBotResult(recordingId, ownerId, type) {
  const owner = await query("select telegram_config->>'botToken' as bot_token from app_users where id = $1", [ownerId]);
  const botToken = owner.rows[0]?.bot_token || process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    return;
  }

  const link = await query('select chat_id from telegram_chat_links where bot_key = $1 and user_id = $2 limit 1', [
    botKeyFor(botToken),
    ownerId,
  ]);
  const chatId = link.rows[0]?.chat_id;

  if (!chatId) {
    return;
  }

  if (type === 'failed') {
    await sendTelegramMessage(botToken, chatId, 'Не удалось обработать запись — откройте приложение, чтобы перезапустить.');
    return;
  }

  const recording = await getRecording(recordingId, ownerId);

  if (!recording) {
    return;
  }

  await sendTelegramText(botToken, chatId, buildResultText(recording));
}
