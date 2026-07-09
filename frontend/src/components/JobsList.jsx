import { formatDate } from '../lib/format.js';

export default function JobsList({ jobs, isCollapsed, onToggleCollapse }) {
  return (
    <section className="detail-section detail-section-jobs">
      <div className="jobs-header">
        <h3>Jobs</h3>
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
                  <strong>{job.status}</strong>
                  <span>{formatDate(job.createdAt)}</span>
                </div>
                {job.error ? <p>{job.error}</p> : null}
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
