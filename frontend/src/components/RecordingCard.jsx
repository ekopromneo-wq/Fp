import { formatDate, formatFileSize } from '../lib/format.js';
import useSwipeAction from '../hooks/useSwipeAction.js';

// syncState is a client-only concept (never sent to/read from the backend)
// tracking a recording that started life in the offline write queue - kept
// as a separate pill from the real backend `status` so the two namespaces
// never collide. Absent/'synced' renders nothing, matching how an already-
// synced recording looks today (zero visual diff for the common case).
function SyncPill({ syncState, syncProgress, syncError }) {
  if (!syncState || syncState === 'synced') {
    return null;
  }

  if (syncState === 'local-pending') {
    return (
      <span className="sync-pill sync-local-pending" title="Сохранено на устройстве, ожидает отправки">
        ✓ на устройстве
      </span>
    );
  }

  if (syncState === 'syncing') {
    const percent = Math.round((syncProgress || 0) * 100);
    return (
      <span className="sync-pill sync-syncing" title="Идёт синхронизация">
        ⟳ синхронизация {percent}%
      </span>
    );
  }

  if (syncState === 'sync-failed') {
    return (
      <span className="sync-pill sync-failed" title={syncError || 'Не удалось синхронизировать'}>
        ⚠ ошибка синхронизации
      </span>
    );
  }

  return null;
}

export default function RecordingCard({ recording, isSelected, onSelect, onDelete, onProcess, isDeleting, enableSwipe }) {
  const { cardRef, trackRef, handlers } = useSwipeAction({
    enabled: Boolean(enableSwipe),
    onSwipeRight: () => onProcess?.(recording),
    onSwipeLeft: () => onDelete?.(recording),
  });

  return (
    <article className={`recording-card ${isSelected ? 'is-selected' : ''}`}>
      <div className="recording-card-clip">
        <div className="recording-card-swipe-bg" ref={trackRef} />

        <div
          className="recording-card-content"
          ref={cardRef}
          onClick={() => onSelect(recording.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(recording.id);
            }
          }}
          {...handlers}
          style={{ touchAction: enableSwipe ? 'pan-y' : undefined }}
        >
          <div className="recording-card-main">
            <strong className="recording-card-title">{recording.title || recording.originalFilename}</strong>

            <div className="recording-meta">
              <span>{formatFileSize(recording.fileSizeBytes)}</span>
              <span>{formatDate(recording.createdAt)}</span>
              {recording.status ? <span className={`status-pill status-${recording.status}`}>{recording.status}</span> : null}
              <SyncPill syncState={recording.syncState} syncProgress={recording.syncProgress} syncError={recording.syncError} />
              {recording.project ? (
                <span className="project-chip" style={{ '--project-color': recording.project.color }}>
                  {recording.project.name}
                </span>
              ) : null}
            </div>
          </div>

          <button
            className="button button-danger icon-button recording-card-delete"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(recording);
            }}
            disabled={isDeleting}
            aria-label="Удалить"
            title="Удалить"
          >
            {isDeleting ? '...' : '✕'}
          </button>
        </div>
      </div>
    </article>
  );
}
