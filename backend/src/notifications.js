import { query } from './db.js';
import { requireAuth, getAuthUser } from './auth.js';
import { sendNotificationEmail } from './email.js';
import { sendNotificationTelegram } from './telegram.js';
import { notifyTelegramBotResult } from './telegramIntake.js';

const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const NOTIFICATION_TEMPLATES = {
  done: (title) => ({
    title: 'Готово',
    message: `Встреча "${title}" распознана, задачи поставлены`,
  }),
  failed: (title) => ({
    title: 'Ошибка',
    message: `По встрече "${title}" сбой`,
  }),
};

function mapNotification(row) {
  return {
    id: row.id,
    recordingId: row.recording_id,
    type: row.type,
    title: row.title,
    message: row.message,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/**
 * Always writes a notifications row (the in-app history/read-status ledger -
 * US-5.2's "история уведомлений" and "прочитано" both depend on this row
 * existing regardless of channel settings), then best-effort fans out to
 * whichever external channels the owner has selected (max 2 total including
 * in_app, enforced in auth.js's normalizeNotificationConfig). A failed
 * external send is logged and swallowed - it must never break whatever
 * triggered it (recording pipeline, task-overdue scan, ...).
 */
async function deliverNotification(ownerId, recordingId, type, title, message) {
  const userResult = await query(
    'select email, smtp_config, telegram_config, notification_config from app_users where id = $1',
    [ownerId],
  );
  const user = userResult.rows[0];

  if (!user) {
    return;
  }

  const config = user.notification_config || {};
  const channels = Array.isArray(config.channels) && config.channels.length ? config.channels : ['in_app', 'email'];

  const inserted = await query(
    `
      insert into notifications (owner_id, recording_id, type, title, message)
      values ($1, $2, $3, $4, $5)
      returning id
    `,
    [ownerId, recordingId, type, title, message],
  );
  const notificationId = inserted.rows[0].id;

  // "Не беспокоить" suppresses external delivery only - the in-app row
  // above is already written, so the user still sees it next time they
  // open the app.
  if (config.dnd) {
    return;
  }

  let delivered = false;

  if (channels.includes('email') && user.email) {
    try {
      await sendNotificationEmail(user.smtp_config || {}, user.email, title, message);
      delivered = true;
    } catch (error) {
      console.warn(`Notification email failed for recording ${recordingId}:`, error.message);
    }
  }

  if (channels.includes('telegram') && user.telegram_config?.chatId) {
    try {
      await sendNotificationTelegram(user.telegram_config, message);
      delivered = true;
    } catch (error) {
      console.warn(`Notification telegram failed for recording ${recordingId}:`, error.message);
    }
  }

  // Per spec: "Прочитано = просмотрено в приложении ИЛИ доставлено в TG/Email."
  if (delivered) {
    await query('update notifications set read_at = now() where id = $1', [notificationId]);
  }
}

export async function notifyRecordingEvent(recordingId, ownerId, type) {
  const template = NOTIFICATION_TEMPLATES[type];

  if (!ownerId || !template) {
    return;
  }

  const recordingResult = await query('select title, source from recordings where id = $1', [recordingId]);
  const recordingTitle = recordingResult.rows[0]?.title || 'запись';
  const { title, message } = template(recordingTitle);

  await deliverNotification(ownerId, recordingId, type, title, message);

  // US-14.1: запись пришла через standalone-бота — результат (или сообщение о
  // сбое) возвращается в тот же чат, помимо обычных каналов уведомлений.
  if (recordingResult.rows[0]?.source === 'telegram_bot' && (type === 'done' || type === 'failed')) {
    try {
      await notifyTelegramBotResult(recordingId, ownerId, type);
    } catch (error) {
      console.warn(`Telegram bot result delivery failed for recording ${recordingId}: ${error.message}`);
    }
  }
}

// US-15.1 (e): бота удалили/исключили из встречи. Отдельное уведомление владельцу —
// запись могла оборваться на середине, поэтому важно сообщить сразу (не дожидаясь
// обычного «готово/сбой»). Пишем in-app + рассылаем по выбранным каналам.
export async function notifyBotRemoved(recordingId, ownerId) {
  if (!ownerId) {
    return;
  }

  const recordingResult = await query('select title from recordings where id = $1', [recordingId]);
  const recordingTitle = recordingResult.rows[0]?.title || 'встреча';

  await deliverNotification(
    ownerId,
    recordingId,
    'bot_removed',
    'Бота удалили из встречи',
    `Бота-ассистента удалили из встречи «${recordingTitle}». Запись остановлена — обработается то, что успело записаться.`,
  );
}

// US-9.3: "Просроченная дата → уведомление". Separate from
// notifyRecordingEvent because the message needs the task's own text, not
// just the recording title - reuses the same insert+fanout mechanics via
// deliverNotification.
export async function notifyTaskOverdue(ownerId, recordingId, task) {
  const recordingResult = await query('select title from recordings where id = $1', [recordingId]);
  const recordingTitle = recordingResult.rows[0]?.title || 'запись';
  const title = 'Задача просрочена';
  const message = `Задача "${task.description}" из встречи "${recordingTitle}" просрочена (срок: ${task.dueText || 'не указан'})`;

  await deliverNotification(ownerId, recordingId, 'task_overdue', title, message);
}

// US-16.1: «уведомление о новом входе». Отдельно от notifyRecordingEvent —
// записи здесь нет, а сообщение говорит про устройство и адрес.
// US-16.5: напоминание о встрече за 15 минут — отдельный тип уведомления,
// открывается на главном экране, где кнопка записи.
export async function notifyMeetingReminder(userId, reminder) {
  const time = new Date(reminder.starts_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  await deliverNotification(
    userId,
    null,
    'meeting_reminder',
    'Скоро встреча',
    `«${reminder.title}» начинается в ${time}. Откройте приложение, чтобы начать запись.`,
  );
}

export async function notifyNewLogin(userId, context = {}) {
  const device = context.userAgent ? context.userAgent.slice(0, 120) : 'неизвестное устройство';
  const from = context.ip && context.ip !== 'local' ? ` (адрес ${context.ip})` : '';
  const message = `Новый вход в аккаунт с устройства: ${device}${from}. Если это не вы — смените пароль и завершите чужие сессии в настройках.`;

  await deliverNotification(userId, null, 'new_login', 'Новый вход в аккаунт', message);
}

export async function cleanupOldNotifications() {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS);
  const result = await query('delete from notifications where created_at < $1', [cutoff]);

  if (result.rowCount > 0) {
    console.log(`Cleaned up ${result.rowCount} notification(s) older than 90 days`);
  }
}

export function registerNotificationRoutes(app) {
  app.get('/api/notifications', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const result = await query(
      `
        select id, recording_id, type, title, message, read_at, created_at
        from notifications
        where owner_id = $1
        order by created_at desc
        limit 50
      `,
      [user.id],
    );
    const notifications = result.rows.map(mapNotification);
    const unreadCount = notifications.filter((notification) => !notification.readAt).length;

    return c.json({ notifications, unreadCount });
  });

  app.post('/api/notifications/:id/read', requireAuth, async (c) => {
    const user = getAuthUser(c);
    await query(
      `
        update notifications
        set read_at = now()
        where id = $1 and owner_id = $2 and read_at is null
      `,
      [c.req.param('id'), user.id],
    );

    return c.json({ ok: true });
  });
}
