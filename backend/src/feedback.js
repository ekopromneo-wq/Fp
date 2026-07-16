import { getAuthUser, requireAuth } from './auth.js';
import { query } from './db.js';

const KINDS = new Set(['error_report', 'rating']);
// Что именно не так — для сообщения об ошибке (US-18.3: стенограмма/пропущенная задача).
const TARGETS = new Set(['transcript', 'task', 'protocol', 'other']);
// US-18.3: периодический опрос — каждая N-я завершённая встреча.
const SURVEY_EVERY = Number(process.env.FEEDBACK_SURVEY_EVERY || 10);

export function registerFeedbackRoutes(app) {
  app.post('/api/feedback', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const kind = KINDS.has(body.kind) ? body.kind : null;

    if (!kind) {
      return c.json({ error: 'Укажите тип обратной связи' }, 400);
    }

    const rating = kind === 'rating' ? Number(body.rating) : null;

    if (kind === 'rating' && !(rating >= 1 && rating <= 5)) {
      return c.json({ error: 'Оценка должна быть от 1 до 5' }, 400);
    }

    const target = kind === 'error_report' && TARGETS.has(body.target) ? body.target : null;
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) || null : null;

    if (kind === 'error_report' && !comment) {
      return c.json({ error: 'Опишите, что не так' }, 400);
    }

    // recording_id принимаем только если запись принадлежит пользователю.
    let recordingId = null;

    if (body.recordingId) {
      const owned = await query('select 1 from recordings where id = $1 and owner_id = $2', [body.recordingId, user.id]);
      recordingId = owned.rowCount ? body.recordingId : null;
    }

    const result = await query(
      `insert into feedback (owner_id, recording_id, kind, rating, target, comment, allow_training)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, created_at`,
      [user.id, recordingId, kind, rating, target, comment, body.allowTraining === true],
    );

    return c.json({ feedback: { id: result.rows[0].id, createdAt: result.rows[0].created_at } }, 201);
  });

  /**
   * US-18.3: пора ли показать опрос оценки. Считаем завершённые встречи и
   * оценки: если готовых встреч кратно N и оценок меньше, чем «положено»,
   * предлагаем оценить. Сознательно грубо — это ненавязчивая подсказка, а не
   * точный счётчик.
   */
  app.get('/api/feedback/survey-due', requireAuth, async (c) => {
    const user = getAuthUser(c);
    const done = await query("select count(*)::int as n from recordings where owner_id = $1 and status = 'done' and deleted_at is null", [user.id]);
    const rated = await query("select count(*)::int as n from feedback where owner_id = $1 and kind = 'rating'", [user.id]);
    const doneCount = done.rows[0].n;
    const ratedCount = rated.rows[0].n;
    const due = doneCount >= SURVEY_EVERY && doneCount >= (ratedCount + 1) * SURVEY_EVERY;

    return c.json({ due, doneCount, ratedCount });
  });
}
