import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { initAudioSystem } from './audioCapture.js';
import { createJob, stopJob } from './jobs.js';

const PORT = Number(process.env.PORT || 8100);
const RECORDER_BOT_INTERNAL_SECRET = process.env.RECORDER_BOT_INTERNAL_SECRET || '';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.use('/jobs/*', async (c, next) => {
  const secret = c.req.header('X-Internal-Secret') || '';

  if (!RECORDER_BOT_INTERNAL_SECRET || secret !== RECORDER_BOT_INTERNAL_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

app.post('/jobs', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  if (!body.recordingId || !body.meetingUrl || !body.platform) {
    return c.json({ error: 'recordingId, meetingUrl and platform are required' }, 400);
  }

  try {
    const job = await createJob(body);

    return c.json(job, 202);
  } catch (error) {
    return c.json({ error: error.message || 'Failed to start job' }, 409);
  }
});

app.post('/jobs/:id/stop', async (c) => {
  const stopped = stopJob(c.req.param('id'));

  if (!stopped) {
    return c.json({ error: 'No active job with that id' }, 404);
  }

  return c.json({ stopped: true });
});

async function main() {
  await initAudioSystem();

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`recorder-bot listening on port ${info.port}`);
  });
}

main().catch((error) => {
  console.error('recorder-bot failed to start:', error);
  process.exit(1);
});
