import { getAuthUser, getUserSmtpConfig, getUserTelegramConfig, requireAuth } from './auth.js';
import { buildEmailContent, buildSubject, sendRecordingEmail } from './email.js';
import { getRecording } from './recordings.js';
import { track } from './analytics.js';
import {
  CHANNELS,
  PAYLOAD_KINDS,
  createShareLink,
  listDeliveries,
  listShareLinks,
  recordDelivery,
  resolveShareToken,
  revokeShareLink,
  sendWithRetry,
  suggestRecipients,
} from './sending.js';
import { sendRecordingTelegram } from './telegram.js';
import { createTelegramLinkCode } from './telegramIntake.js';

function normalizePayloadKind(value) {
  return PAYLOAD_KINDS.includes(value) ? value : 'protocol';
}

// Ссылка на результат должна вести на публичный адрес приложения, а не на
// адрес, с которого пришёл запрос: PWA и клиент-ноутбук ходят в API с разных
// origin'ов, а ссылку получателю надо дать одну и ту же.
function shareBaseUrl(c) {
  return process.env.PUBLIC_APP_URL || new URL(c.req.url).origin;
}

/**
 * Кому ушло сообщение — для журнала доставки. У почты это адреса, у Telegram —
 * чат, у Битрикса получателя как такового нет (задачи заводятся на
 * сотрудников), поэтому там список пустой.
 */
function deliveryRecipients(channel, input, result) {
  if (channel === 'email') {
    // nodemailer возвращает в `accepted` всех принятых получателей — вместе с
    // CC и BCC, поэтому добавлять их отдельно значит задвоить список.
    return [...new Set((result?.accepted || []).map(String))];
  }

  if (channel === 'telegram') {
    return [String(result?.chatId || input.chatId || '')].filter(Boolean);
  }

  return [];
}

function requestedRecipients(channel, input) {
  if (channel === 'email') {
    const source = Array.isArray(input.recipients) ? input.recipients : String(input.recipients || '').split(/[,\n;]/);
    return source.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (channel === 'telegram') {
    return [String(input.chatId || '')].filter(Boolean);
  }

  return [];
}

// US-11.1: «при ошибке канала — сообщение + альтернативный канал».
const CHANNEL_LABELS = { email: 'почту', telegram: 'Telegram', bitrix: 'Битрикс24' };

function alternativeChannels(channel) {
  return CHANNELS.filter((item) => item !== channel && item !== 'bitrix');
}

export function registerSendingRoutes(app) {
  /**
   * Единая отправка (US-11.1): канал + что шлём + получатели. Автоповтор,
   * запись в журнал доставки и подсказка про альтернативный канал живут здесь,
   * чтобы не расползаться по каналам.
   */
  app.post('/api/recordings/:id/send', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const channel = CHANNELS.includes(body.channel) ? body.channel : null;

    if (!channel || channel === 'bitrix') {
      return c.json({ error: 'Укажите канал отправки: email или telegram' }, 400);
    }

    const payloadKind = normalizePayloadKind(body.payloadKind);
    const input = { ...body, payloadKind };
    // Настройки канала читаем один раз: между попытками они не меняются.
    const channelConfig =
      channel === 'email' ? (await getUserSmtpConfig(user.id)) || {} : (await getUserTelegramConfig(user.id)) || {};

    try {
      const { result, attempts } = await sendWithRetry(() =>
        channel === 'email'
          ? sendRecordingEmail(recording, input, channelConfig)
          : sendRecordingTelegram(recording, input, channelConfig),
      );

      const delivery = await recordDelivery({
        ownerId: user.id,
        recordingId: recording.id,
        channel,
        payloadKind,
        recipients: deliveryRecipients(channel, input, result),
        status: 'sent',
        attempts,
        externalRefs: result,
      });

      // Именованные события неполных задач (NFR §6) считаем в per-task маршрутах
      // send-email/send-telegram, где известна конкретная задача. Здесь — только
      // канальная доставка (bulk-дайджест протокола/сводки/задач).
      track('delivery_sent', { userId: user.id, recordingId: recording.id, props: { channel, payloadKind } });

      return c.json({ delivery, result });
    } catch (error) {
      const attempts = error.attempts || 1;
      const delivery = await recordDelivery({
        ownerId: user.id,
        recordingId: recording.id,
        channel,
        payloadKind,
        recipients: requestedRecipients(channel, input),
        status: 'failed',
        attempts,
        lastError: error.message,
      });

      track('delivery_failed', { userId: user.id, recordingId: recording.id, props: { channel, payloadKind } });

      return c.json(
        {
          error: error.message || 'Не удалось отправить',
          delivery,
          attempts,
          // Три попытки исчерпаны — предлагаем сменить канал (US-11.1).
          suggestAlternativeChannel: !error.permanent || attempts >= 3,
          alternativeChannels: alternativeChannels(channel).map((item) => ({ channel: item, label: CHANNEL_LABELS[item] })),
        },
        400,
      );
    }
  });

  /**
   * Предпросмотр (US-11.1): показываем ровно тот текст, который уйдёт, —
   * собирает его тот же код, что и отправку, иначе предпросмотр однажды
   * разойдётся с письмом.
   */
  app.get('/api/recordings/:id/send-preview', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const payloadKind = normalizePayloadKind(c.req.query('payloadKind'));
    const { text } = buildEmailContent(recording, c.req.query('message') || '', payloadKind);

    return c.json({ preview: { payloadKind, subject: buildSubject(recording, payloadKind), text } });
  });

  app.get('/api/recordings/:id/deliveries', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ deliveries: await listDeliveries(recording.id, user.id) });
  });

  /**
   * US-14.1: код привязки личного чата к аккаунту. Пользователь шлёт его своему
   * боту — поллер воркера связывает чат с аккаунтом, дальше бот принимает
   * голосовые/файлы/ссылки и возвращает протокол с задачами.
   */
  app.post('/api/telegram/link-code', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const { code, expiresAt } = await createTelegramLinkCode(user.id);
    const telegramConfig = await getUserTelegramConfig(user.id);

    return c.json({
      code,
      expiresAt,
      botConfigured: Boolean(telegramConfig?.botToken || process.env.TELEGRAM_BOT_TOKEN),
    });
  });

  app.get('/api/recipient-suggestions', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const channel = CHANNELS.includes(c.req.query('channel')) ? c.req.query('channel') : 'email';

    return c.json({ suggestions: await suggestRecipients(user.id, channel) });
  });

  app.get('/api/recordings/:id/share-links', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ shareLinks: await listShareLinks(recording.id, user.id, shareBaseUrl(c)) });
  });

  app.post('/api/recordings/:id/share-links', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const recording = await getRecording(c.req.param('id'), user.id);

    if (!recording) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const shareLink = await createShareLink({
      ownerId: user.id,
      recordingId: recording.id,
      payloadKind: normalizePayloadKind(body.payloadKind),
      baseUrl: shareBaseUrl(c),
    });

    return c.json({ shareLink }, 201);
  });

  app.delete('/api/share-links/:id', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const shareLink = await revokeShareLink(c.req.param('id'), user.id, shareBaseUrl(c));

    if (!shareLink) {
      return c.json({ error: 'Ссылка не найдена или уже отозвана' }, 404);
    }

    return c.json({ shareLink });
  });

  /**
   * Публичное чтение по ссылке (US-11.1): без авторизации и без пароля, но
   * только то, что владелец решил показать, и только пока ссылка жива. Аудио,
   * стенограмма и служебные поля наружу не отдаются.
   */
  app.get('/api/share/:token', async (c) => {
    const resolved = await resolveShareToken(c.req.param('token'));

    if (resolved.status === 'not_found') {
      return c.json({ error: 'Ссылка не найдена' }, 404);
    }

    if (resolved.status === 'revoked') {
      return c.json({ error: 'Доступ по ссылке отозван' }, 410);
    }

    if (resolved.status === 'expired') {
      return c.json({ error: 'Срок действия ссылки истёк' }, 410);
    }

    const { link } = resolved;
    const recording = await getRecording(link.recording_id, link.owner_id);

    if (!recording) {
      return c.json({ error: 'Встреча не найдена' }, 404);
    }

    const withSummary = link.payload_kind === 'protocol' || link.payload_kind === 'summary';
    const withTasks = link.payload_kind === 'protocol' || link.payload_kind === 'tasks';

    return c.json({
      payloadKind: link.payload_kind,
      expiresAt: link.expires_at,
      recording: {
        title: recording.title,
        createdAt: recording.createdAt,
        meetingType: recording.meetingType,
        protocolTemplate: recording.protocolTemplate,
        projects: (recording.projects || []).map((project) => ({ name: project.name, color: project.color })),
        summary: withSummary
          ? {
              executiveSummary: recording.summary?.executiveSummary || null,
              summary: recording.summary?.summary || null,
              protocol: link.payload_kind === 'protocol' ? recording.summary?.protocol || null : null,
            }
          : null,
        tasks: withTasks
          ? (recording.tasks || []).map((task) => ({
              assignee: task.assignee,
              dueText: task.dueText,
              status: task.status,
              description: task.description,
            }))
          : null,
      },
    });
  });
}
