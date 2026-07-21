import { formatDate, formatFileSize } from '../lib/format.js';
import { getStatusLabel } from '../lib/statusLabels.js';
import useSwipeAction from '../hooks/useSwipeAction.js';

// syncState is a client-only concept (never sent to/read from the backend)
// tracking a recording that started life in the offline write queue - kept
// as a separate pill from the real backend `status` so the two namespaces
// never collide. Absent/'synced' renders nothing, matching how an already-
// synced recording looks today (zero visual diff for the common case).
function SyncPill({ syncState, syncProgress, syncError }) {
  if (!syncState) {
    return null;
  }

  // US-3.2: две галочки = отправлено в облако (показываем ненадолго после синка).
  if (syncState === 'synced') {
    return (
      <span className="sync-pill sync-synced" title="Отправлено в облако">
        ✓✓ отправлено
      </span>
    );
  }

  if (syncState === 'local-pending') {
    return (
      <span className="sync-pill sync-local-pending" title="Сохранено на устройстве, ожидает отправки">
        ✓ на устройстве
      </span>
    );
  }

  // US-3.5: запись «только на устройстве» — не выгружается, при удалении
  // приложения теряется. Отдельная пилюля с предупреждающим тоном.
  if (syncState === 'device-only') {
    return (
      <span className="sync-pill sync-device-only" title="Только на устройстве — не выгружается, при удалении приложения теряется">
        🔒 только на устройстве
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
              {recording.status ? (
                <span className={`status-pill status-${recording.status}`}>{getStatusLabel(recording.status)}</span>
              ) : null}
              {recording.confidential ? <span className="confidential-badge">🔒 Конфиденциально</span> : null}
              <SyncPill syncState={recording.syncState} syncProgress={recording.syncProgress} syncError={recording.syncError} />
              {(recording.projects?.length ? recording.projects : recording.project ? [recording.project] : []).map((project) => (
                <span className="project-chip" key={project.id} style={{ '--project-color': project.color }}>
                  {project.name}
                </span>
              ))}
            </div>

            {/* Причину сбоя выгрузки показываем прямо на карточке — на мобильном
                tooltip недоступен, а без причины непонятно, лечится ли повтором. */}
            {recording.syncState === 'sync-failed' && recording.syncError ? (
              <p className="sync-error-detail">Причина: {recording.syncError}. Нажмите «Синхронизировать», чтобы повторить.</p>
            ) : null}
          </div>

          <button
            className="recording-card-delete"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(recording);
            }}
            disabled={isDeleting}
            aria-label="Удалить запись"
            title="Удалить"
          >
            {isDeleting ? '…' : '✕'}
          </button>
        </div>
      </div>
    </article>
  );
}
