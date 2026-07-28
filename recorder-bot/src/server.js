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
  // STG-001: тот же ID, что backend пишет в свой журнал подключений (botLog) -
  // строка в этом логе находится по коду, который видит пользователь/поддержка,
  // без сверки по времени между двумя контейнерами.
  const correlationId = c.req.header('X-Correlation-Id') || '';
  const logPrefix = correlationId ? `[${correlationId}] ` : '';

  if (!body.recordingId || !body.meetingUrl || !body.platform) {
    return c.json({ error: 'recordingId, meetingUrl and platform are required' }, 400);
  }

  try {
    const job = await createJob(body);
    console.log(`${logPrefix}job ${job.jobId} created for recording ${body.recordingId}`);

    return c.json(job, 202);
  } catch (error) {
    console.warn(`${logPrefix}job creation failed for recording ${body.recordingId}: ${error.message}`);
    // STG-001(d): раньше ЛЮБАЯ ошибка createJob (в т.ч. падение Playwright,
    // неподдерживаемая платформа) маппилась в 409 - выглядело как "конфликт",
    // хотя настоящий конфликт (занятый инстанс) — только один из случаев.
    if (error.message === 'Another recording is already in progress on this recorder-bot instance') {
      return c.json({ error: error.message }, 409);
    }
    if (error.message?.startsWith('Unsupported platform:')) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: error.message || 'Failed to start job' }, 502);
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
