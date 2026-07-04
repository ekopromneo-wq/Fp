import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { query } from './db.js';

const SESSION_COOKIE = 'voxmate_session';
const SESSION_TTL_DAYS = 30;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        const key = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
        const value = separatorIndex === -1 ? '' : part.slice(separatorIndex + 1);
        return [key, decodeURIComponent(value)];
      }),
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash || '').split('$');

  if (algorithm !== 'scrypt' || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function mapUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSmtpConfig(input = {}, previous = {}) {
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const port = Number(input.port || 587);
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const from = typeof input.from === 'string' ? input.from.trim() : '';
  const passInput = typeof input.pass === 'string' ? input.pass : '';
  const pass = passInput || previous.pass || '';

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: Boolean(input.secure),
    user,
    pass,
    from,
  };
}

function publicSmtpConfig(config = {}) {
  return {
    host: config.host || '',
    port: config.port || 587,
    secure: Boolean(config.secure),
    user: config.user || '',
    from: config.from || '',
    hasPassword: Boolean(config.pass),
  };
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `
      insert into auth_sessions (user_id, token_hash, expires_at)
      values ($1, $2, $3)
    `,
    [userId, tokenHash, expiresAt],
  );

  return {
    token,
    cookie: serializeCookie(SESSION_COOKIE, token, {
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
      expires: expiresAt,
    }),
  };
}

async function getCurrentUser(c) {
  const cookies = parseCookies(c.req.header('Cookie'));
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const result = await query(
    `
      select u.id, u.display_name, u.email, u.created_at, u.updated_at
      from auth_sessions s
      join app_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1
    `,
    [tokenHash],
  );

  if (result.rowCount === 0) {
    return null;
  }

  await query('update auth_sessions set last_seen_at = now() where token_hash = $1', [tokenHash]);
  return mapUser(result.rows[0]);
}

export async function requireAuth(c, next) {
  const user = await getCurrentUser(c);

  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  c.set('currentUser', user);
  await next();
}

export function getAuthUser(c) {
  return c.get('currentUser');
}

export async function getUserSmtpConfig(userId) {
  const result = await query('select smtp_config from app_users where id = $1', [userId]);
  return result.rows[0]?.smtp_config || null;
}

export function registerAuthRoutes(app) {
  app.get('/api/auth/me', async (c) => {
    const user = await getCurrentUser(c);
    return c.json({ user });
  });

  app.get('/api/settings/smtp', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const config = await getUserSmtpConfig(user.id);

    return c.json({ smtp: publicSmtpConfig(config || {}) });
  });

  app.patch('/api/settings/smtp', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const previous = (await getUserSmtpConfig(user.id)) || {};
    const config = normalizeSmtpConfig(body, previous);

    await query('update app_users set smtp_config = $1::jsonb, updated_at = now() where id = $2', [
      JSON.stringify(config),
      user.id,
    ]);

    return c.json({ smtp: publicSmtpConfig(config) });
  });

  app.post('/api/auth/register', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : email.split('@')[0];

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email is required' }, 400);
    }

    if (password.length < 6) {
      return c.json({ error: 'Password must be at least 6 characters' }, 400);
    }

    const existing = await query('select id from app_users where email = $1', [email]);

    if (existing.rowCount > 0) {
      return c.json({ error: 'User already exists' }, 409);
    }

    const inserted = await query(
      `
        insert into app_users (display_name, email, password_hash)
        values ($1, $2, $3)
        returning id, display_name, email, created_at, updated_at
      `,
      [displayName, email, hashPassword(password)],
    );
    const user = mapUser(inserted.rows[0]);
    const session = await createSession(user.id);

    c.header('Set-Cookie', session.cookie);
    return c.json({ user }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    const result = await query(
      `
        select id, display_name, email, password_hash, created_at, updated_at
        from app_users
        where email = $1
        limit 1
      `,
      [email],
    );

    if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const user = mapUser(result.rows[0]);
    const session = await createSession(user.id);

    c.header('Set-Cookie', session.cookie);
    return c.json({ user });
  });

  app.post('/api/auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('Cookie'));
    const token = cookies[SESSION_COOKIE];

    if (token) {
      await query('delete from auth_sessions where token_hash = $1', [hashToken(token)]);
    }

    c.header(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', {
        maxAge: 0,
        expires: new Date(0),
      }),
    );
    return c.json({ ok: true });
  });
}
