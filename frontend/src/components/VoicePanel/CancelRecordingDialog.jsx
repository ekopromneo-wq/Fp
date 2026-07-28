import useEscapeKey from '../../hooks/useEscapeKey.js';
import { formatDuration } from '../../lib/format.js';

/**
 * STG-005: раньше "Отменить" всегда означало безвозвратное удаление, даже
 * если к этому моменту уже записалось несколько минут - один клик и
 * подтверждение browser confirm() стирали всё без альтернативы. Показываем
 * этот выбор только когда есть что терять (см. VoicePanel.jsx - для долей
 * секунды в начале записи по-прежнему обычный window.confirm).
 */
export default function CancelRecordingDialog({ duration, onDelete, onSave, onDismiss }) {
  useEscapeKey(onDismiss);

  return (
    <div
      className="stop-or-background-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-recording-title"
      onClick={onDismiss}
    >
      <div className="stop-or-background-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onDismiss} aria-label="Закрыть">
          ✕
        </button>
        <h2 id="cancel-recording-title">Отменить запись?</h2>
        <p className="consent-notice">Уже записано {formatDuration(duration)}. Удалить фрагмент или сохранить как есть?</p>
        <div className="stop-or-background-actions">
          <button className="button button-danger" type="button" onClick={onDelete}>
            Удалить
          </button>
          <button className="button button-primary" type="button" onClick={onSave}>
            Сохранить как есть
          </button>
        </div>
      </div>
    </div>
  );
}
