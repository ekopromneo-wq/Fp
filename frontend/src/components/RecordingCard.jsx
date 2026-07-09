import { formatDate, formatFileSize } from '../lib/format.js';
import useSwipeAction from '../hooks/useSwipeAction.js';

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
              <span className={`status-pill status-${recording.status}`}>{recording.status}</span>
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
