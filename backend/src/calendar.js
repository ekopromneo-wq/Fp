import { createHash, randomBytes } from 'node:crypto';
import { getAuthUser, requireAuth } from './auth.js';
import { query } from './db.js';

// US-16.5 (ADR-028): Outlook / Microsoft 365 через Microsoft OAuth + Graph.
// Тесты подменяют базовые URL, чтобы прогнать поток и опрос против фейка.
const MS_TENANT = process.env.MS_OAUTH_TENANT || 'common';
const MS_AUTH_URL = () =>
  process.env.MS_OAUTH_AUTH_URL || `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = () =>
  process.env.MS_OAUTH_TOKEN_URL || `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`;
const GRAPH_BASE = () => process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0';
// Минимизация scopes (US-16.5): только чтение календаря + offline для refresh.
const MS_SCOPE = 'offline_access Calendars.Read';
const REMINDER_LEAD_MINUTES = Number(process.env.CALENDAR_REMINDER_LEAD_MINUTES || 15);
// Насколько вперёд смотрим события при опросе.
const LOOKAHEAD_HOURS = Number(process.env.CALENDAR_LOOKAHEAD_HOURS || 24);

function msCreds() {
  return {
    clientId: process.env.MS_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.MS_OAUTH_CLIENT_SECRET || '',
  };
}

export function isCalendarEnabled() {
  const { clientId, clientSecret } = msCreds();
  return Boolean(clientId && clientSecret);
}

function redirectUri(requestUrl) {
  const base = (process.env.OAUTH_REDIRECT_BASE || process.env.PUBLIC_APP_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
  return `${base}/api/calendar/microsoft/callback`;
}

async function refreshAccessToken(connection) {
  const { clientId, clientSecret } = msCreds();
  const response = await fetch(MS_TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      scope: MS_SCOPE,
    }),
  });
  const token = await response.json().catch(() => null);

  if (!response.ok || !token?.access_token) {
    // US-16.5: истёкший/отозванный refresh → просим переподключить.
    await query("update calendar_connections set status = 'needs_reconnect', updated_at = now() where user_id = $1", [
      connection.user_id,
    ]);
    throw new Error('Не удалось обновить токен календаря — требуется переподключение');
  }

  const expiresAt = new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000);
  await query(
    `update calendar_connections set access_token = $2, refresh_token = coalesce($3, refresh_token),
       expires_at = $4, status = 'connected', updated_at = now() where user_id = $1`,
    [connection.user_id, token.access_token, token.refresh_token || null, expiresAt],
  );

  return token.access_token;
}

async function validAccessToken(connection) {
  const notExpired = connection.expires_at && new Date(connection.expires_at).getTime() > Date.now() + 60000;
  return notExpired && connection.access_token ? connection.access_token : refreshAccessToken(connection);
}

/**
 * События календаря на ближайшие сутки через Graph calendarView. Напоминания
 * пишутся идемпотентно (uniq user+event): повторный опрос обновляет время/заголовок
 * (US-16.5 «изменение события обновляет напоминание»), сбрасывая notified_at,
 * если встреча уехала вперёд.
 */
async function syncUserCalendar(connection) {
  const accessToken = await validAccessToken(connection);
  const now = new Date();
  const end = new Date(now.getTime() + LOOKAHEAD_HOURS * 3600 * 1000);
  const url = `${GRAPH_BASE()}/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=id,subject,start&$orderby=start/dateTime&$top=25`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error?.message || `Graph calendarView failed with ${response.status}`);
  }

  const events = Array.isArray(body?.value) ? body.value : [];
  const seen = [];

  for (const event of events) {
    const startsAt = event.start?.dateTime ? new Date(`${event.start.dateTime}Z`.replace(/Z+$/, 'Z')) : null;

    if (!startsAt || Number.isNaN(startsAt.getTime())) {
      continue;
    }

    const remindAt = new Date(startsAt.getTime() - REMINDER_LEAD_MINUTES * 60000);
    seen.push(event.id);

    await query(
      `insert into calendar_reminders (user_id, event_id, title, starts_at, remind_at)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, event_id) do update set
         title = excluded.title,
         starts_at = excluded.starts_at,
         remind_at = excluded.remind_at,
         -- время сдвинулось вперёд → напомним заново
         notified_at = case when excluded.starts_at <> calendar_reminders.starts_at then null else calendar_reminders.notified_at end,
         updated_at = now()`,
      [connection.user_id, event.id, event.subject || 'Встреча', startsAt, remindAt],
    );
  }

  // Событие исчезло из календаря (отменено) — убираем ненаступившее напоминание.
  await query(
    `delete from calendar_reminders where user_id = $1 and notified_at is null
       and ($2::text[] = '{}' or event_id <> all($2::text[]))`,
    [connection.user_id, seen],
  );

  return { events: events.length };
}

/**
 * Фоновый проход (worker): опрашивает подключённые календари и рассылает
 * наступившие напоминания. Вызывается по таймеру.
 */
export async function pollCalendars(deliverReminder) {
  if (!isCalendarEnabled()) {
    return;
  }

  const connections = await query("select * from calendar_connections where status = 'connected'");

  for (const connection of connections.rows) {
    try {
      await syncUserCalendar(connection);
    } catch (error) {
      console.warn(`Calendar sync failed for user ${connection.user_id}: ${error.message}`);
    }
  }

  // Наступившие, но ещё не отправленные напоминания (для всех пользователей).
  const due = await query(
    `select id, user_id, title, starts_at from calendar_reminders
     where notified_at is null and remind_at <= now() and starts_at > now() - interval '5 minutes'`,
  );

  for (const reminder of due.rows) {
    try {
      await deliverReminder(reminder);
      await query('update calendar_reminders set notified_at = now(), updated_at = now() where id = $1', [reminder.id]);
    } catch (error) {
      console.warn(`Reminder delivery failed ${reminder.id}: ${error.message}`);
    }
  }
}

export function registerCalendarRoutes(app) {
  app.get('/api/calendar/status', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const result = await query('select provider, status, connected_at from calendar_connections where user_id = $1', [user.id]);

    return c.json({
      enabled: isCalendarEnabled(),
      connection: result.rows[0] || null,
    });
  });

  app.get('/api/calendar/microsoft/connect', requireAuth, async (c) => {
    const user = getAuthUser(c);

    if (!isCalendarEnabled()) {
      return c.json({ error: 'Календарь не настроен' }, 404);
    }

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');

    await query('delete from calendar_oauth_states where created_at < now() - interval \'15 minutes\'', []);
    await query('insert into calendar_oauth_states (state, user_id, code_verifier) values ($1, $2, $3)', [
      state,
      user.id,
      verifier,
    ]);

    const { clientId } = msCreds();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri(c.req.url),
      scope: MS_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
    });

    return c.redirect(`${MS_AUTH_URL()}?${params}`);
  });

  app.get('/api/calendar/microsoft/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const appUrl = (process.env.PUBLIC_APP_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
    const fail = (reason) => c.redirect(`${appUrl}/?calendar_error=${encodeURIComponent(reason)}`);

    if (!code || !state) {
      return fail('Не удалось подключить календарь');
    }

    const stored = await query('delete from calendar_oauth_states where state = $1 returning user_id, code_verifier', [state]);

    if (!stored.rowCount) {
      return fail('Сессия подключения устарела');
    }

    const { user_id: userId, code_verifier: verifier } = stored.rows[0];
    const { clientId, clientSecret } = msCreds();

    try {
      const response = await fetch(MS_TOKEN_URL(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(c.req.url),
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: verifier,
          scope: MS_SCOPE,
        }),
      });
      const token = await response.json().catch(() => null);

      if (!response.ok || !token?.refresh_token) {
        throw new Error(token?.error_description || `Обмен кода не удался (${response.status})`);
      }

      const expiresAt = new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000);
      await query(
        `insert into calendar_connections (user_id, provider, access_token, refresh_token, expires_at, status, connected_at, updated_at)
         values ($1, 'microsoft', $2, $3, $4, 'connected', now(), now())
         on conflict (user_id) do update set
           access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, status = 'connected', updated_at = now()`,
        [userId, token.access_token, token.refresh_token, expiresAt],
      );

      return c.redirect(`${appUrl}/?calendar=connected`);
    } catch (error) {
      console.warn(`Calendar connect failed for user ${userId}: ${error.message}`);
      return fail('Не удалось подключить календарь');
    }
  });

  app.delete('/api/calendar/connection', requireAuth, async (c) => {
    const user = getAuthUser(c);
    await query('delete from calendar_connections where user_id = $1', [user.id]);
    await query('delete from calendar_reminders where user_id = $1', [user.id]);
    return c.json({ ok: true });
  });

  // Предстоящие встречи для главного экрана (US-13.1 блок «предстоящие встречи»).
  app.get('/api/calendar/upcoming', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const result = await query(
      `select event_id, title, starts_at from calendar_reminders
       where user_id = $1 and starts_at > now() order by starts_at asc limit 5`,
      [user.id],
    );

    return c.json({ upcoming: result.rows.map((row) => ({ eventId: row.event_id, title: row.title, startsAt: row.starts_at })) });
  });
}
