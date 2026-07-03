import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

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

app.get('/api/hello', (c) => {
  return c.json({
    message: 'Hello from VoxMate backend',
  });
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`VoxMate backend listening on http://localhost:${info.port}`);
  },
);
