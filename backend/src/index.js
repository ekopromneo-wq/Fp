import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cleanupExpiredAuthSessions, registerAuthRoutes } from './auth.js';
import { checkDependencies } from './health.js';
import { registerRecordingRoutes } from './recordings.js';
import { registerUploadSessionRoutes } from './uploadSessionRoutes.js';
import { cleanupStaleUploadSessions } from './uploadSessions.js';
import { registerNotificationRoutes, cleanupOldNotifications } from './notifications.js';
import { registerContactRoutes } from './contacts.js';
import { registerSendingRoutes } from './sendingRoutes.js';
import { registerFeedbackRoutes } from './feedback.js';
import { runMigrations } from './migrations.js';
import { ensureAudioBucket } from './storage.js';

dotenv.config();

const port = Number(process.env.PORT || 4000);
const app = new Hono();

// Sessions are cookie-based (credentials: 'include' on the frontend), so
// reflecting any Origin back here while allowing credentials would let any
// external site ride a logged-in user's session cross-origin. Only ever set
// Allow-Origin for an explicitly allowlisted origin.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || `http://localhost:${process.env.WEB_PORT || 4173}`)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');

  if (origin && corsAllowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }

  c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

app.get('/', (c) => c.text('VoxMate backend running'));

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'voxmate-api',
    environment: process.env.NODE_ENV || 'development',
  });
});

app.get('/health/live', (c) => {
  return c.json({
    status: 'ok',
    service: 'voxmate-api',
    environment: process.env.NODE_ENV || 'development',
  });
});

app.get('/health/ready', async (c) => {
  const result = await checkDependencies();

  return c.json(
    {
      service: 'voxmate-api',
      environment: process.env.NODE_ENV || 'development',
      ...result,
    },
    result.status === 'ok' ? 200 : 503,
  );
});

app.get('/api/hello', (c) => {
  return c.json({
    message: 'Hello from VoxMate backend',
  });
});

registerAuthRoutes(app);
registerRecordingRoutes(app);
registerUploadSessionRoutes(app);
registerNotificationRoutes(app);
registerContactRoutes(app);
registerSendingRoutes(app);
registerFeedbackRoutes(app);

const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000);

async function runCleanup() {
  await cleanupStaleUploadSessions();
  await cleanupOldNotifications();
  await cleanupExpiredAuthSessions();
}

async function main() {
  await runMigrations();
  await ensureAudioBucket();
  await runCleanup();

  // The API process typically runs for weeks between deploys - a
  // startup-only cleanup never fires again on a long-lived container.
  setInterval(() => {
    runCleanup().catch((error) => console.warn('Cleanup loop error:', error.message));
  }, CLEANUP_INTERVAL_MS);

  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`VoxMate backend listening on http://localhost:${info.port}`);
    },
  );
}

main().catch((error) => {
  console.error('Backend failed to start', error);
  process.exit(1);
});
