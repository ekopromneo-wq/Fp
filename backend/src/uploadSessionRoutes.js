import { bodyLimit } from 'hono/body-limit';
import { getAuthUser, requireAuth } from './auth.js';
import { UploadValidationError } from './uploadValidation.js';
import {
  UploadSessionError,
  createOrResumeUploadSession,
  getUploadSessionState,
  appendChunk,
  completeUploadSession,
} from './uploadSessions.js';

const CHUNK_BODY_LIMIT_BYTES = Number(process.env.UPLOAD_CHUNK_SIZE_BYTES || 5 * 1024 * 1024) + 1024 * 1024;

function respondSessionError(c, error) {
  if (error instanceof UploadSessionError) {
    return c.json({ error: error.message, code: error.code, expectedOffset: error.expectedOffset }, error.code === 'offset_mismatch' ? 409 : 400);
  }

  if (error instanceof UploadValidationError) {
    return c.json({ error: error.message, code: error.code }, 400);
  }

  throw error;
}

export function registerUploadSessionRoutes(app) {
  app.post('/api/recordings/:id/upload-session', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));

    if (!body.originalFilename || !body.mimeType || !Number.isFinite(Number(body.totalSizeBytes))) {
      return c.json({ error: 'originalFilename, mimeType and totalSizeBytes are required' }, 400);
    }

    const session = await createOrResumeUploadSession(c.req.param('id'), user.id, {
      originalFilename: body.originalFilename,
      mimeType: body.mimeType,
      totalSizeBytes: Number(body.totalSizeBytes),
    });

    if (!session) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ session });
  });

  app.get('/api/recordings/:id/upload-session', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const session = await getUploadSessionState(c.req.param('id'), user.id);

    if (!session) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    return c.json({ session });
  });

  app.put(
    '/api/recordings/:id/upload-session/chunk',
    requireAuth,
    bodyLimit({
      maxSize: CHUNK_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'Chunk too large' }, 413),
    }),
    async (c) => {
      const user = getAuthUser(c);
      const offset = Number(c.req.query('offset'));

      if (!Number.isFinite(offset) || offset < 0) {
        return c.json({ error: 'offset query param is required' }, 400);
      }

      const chunkBuffer = Buffer.from(await c.req.arrayBuffer());

      if (!chunkBuffer.length) {
        return c.json({ error: 'Empty chunk body' }, 400);
      }

      try {
        const result = await appendChunk(c.req.param('id'), user.id, offset, chunkBuffer);

        if (!result) {
          return c.json({ error: 'Recording not found' }, 404);
        }

        return c.json(result);
      } catch (error) {
        return respondSessionError(c, error);
      }
    },
  );

  app.post('/api/recordings/:id/upload-session/complete', requireAuth, async (c) => {
    const user = getAuthUser(c);

    try {
      const recording = await completeUploadSession(c.req.param('id'), user.id);

      if (!recording) {
        return c.json({ error: 'Recording not found' }, 404);
      }

      return c.json({ recording });
    } catch (error) {
      return respondSessionError(c, error);
    }
  });
}
