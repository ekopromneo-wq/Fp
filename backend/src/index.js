import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { checkDependencies } from './health.js';
import { registerRecordingRoutes } from './recordings.js';
import { runMigrations } from './migrations.js';
import { ensureAudioBucket } from './storage.js';

dotenv.config();

const port = Number(process.env.PORT || 4000);
const app = new Hono();

app.use('/api/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

registerRecordingRoutes(app);

async function main() {
  await runMigrations();
  await ensureAudioBucket();

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
