import { formatDate } from '../lib/format.js';
import { getStatusLabel } from '../lib/statusLabels.js';

// STG-008: раньше сюда шёл сырой текст ошибки от провайдера как есть
// (например "OpenRouter ASR failed with 400. Audio payload: 0 MB") - для
// пользователя это ничего не значит и пугает техническими подробностями.
// Показываем понятное сообщение + короткий diagnostic ID (первые 8 символов
// UUID задачи - этого достаточно, чтобы найти запись в логах по job.error),
// сам текст ошибки остаётся в БД (processing_jobs.error) для поддержки и
// доступен по клику "Показать подробности".
function diagnosticId(jobId) {
  return String(jobId || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

export default function JobsList({ jobs, isCollapsed, onToggleCollapse }) {
  return (
    <section className="detail-section detail-section-jobs">
      <div className="jobs-header">
        <h3>Обработка</h3>
        <button className="button button-secondary" type="button" onClick={onToggleCollapse}>
          {isCollapsed ? 'Развернуть' : 'Свернуть'}
        </button>
      </div>

      {!isCollapsed ? (
        jobs?.length ? (
          <div className="job-list">
            {jobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div>
                  <strong>{getStatusLabel(job.status)}</strong>
                  <span>{formatDate(job.createdAt)}</span>
                </div>
                {job.error ? (
                  <div className="job-error">
                    <p>
                      Не удалось обработать запись. Код для поддержки: <code>{diagnosticId(job.id)}</code>
                    </p>
                    <details>
                      <summary>Технические подробности</summary>
                      <p className="job-error-raw">{job.error}</p>
                    </details>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-text">Обработки ещё не запускались.</p>
        )
      ) : null}
    </section>
  );
}
