import Waveform from './Waveform.jsx';
import BrandMicIcon from '../BrandMicIcon.jsx';
import { formatDuration } from '../../lib/format.js';

export default function VoicePanel({
  isOpen,
  onClose,
  isMicRecording,
  isMicPaused,
  canPauseMicRecording,
  micDuration,
  micLevel,
  isMicLevelLow,
  analyserRef,
  onToggleRecording,
  onTogglePause,
  status,
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="voice-panel-overlay" onClick={onClose}>
      <section
        className="voice-panel"
        aria-label="Запись с микрофона"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="voice-panel-handle" />

        <button className="voice-panel-close" type="button" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>

        {isMicRecording ? (
          <div className="voice-panel-recording">
            <div className={`voice-panel-pulse ${isMicPaused ? 'is-paused' : ''}`} />
            <Waveform analyserRef={analyserRef} isActive={isMicRecording && !isMicPaused} />
            <p className={`voice-panel-duration ${isMicPaused ? 'is-paused' : ''}`} aria-live="polite">
              {formatDuration(micDuration)}
            </p>
            <p className="voice-panel-status">{status || (isMicPaused ? 'На паузе' : 'Идёт запись...')}</p>
            {isMicLevelLow && !isMicPaused ? (
              <p className="voice-panel-warning" role="alert">
                Тихо или микрофон не слышно — проверьте звук
              </p>
            ) : null}
          </div>
        ) : (
          <div className="voice-panel-idle">
            <p className="voice-panel-status">{status || 'Готово к записи'}</p>
          </div>
        )}

        <div className="voice-panel-controls">
          {isMicRecording && canPauseMicRecording ? (
            <button
              className="voice-panel-pause-button"
              type="button"
              onClick={onTogglePause}
              aria-label={isMicPaused ? 'Продолжить запись' : 'Поставить на паузу'}
            >
              {isMicPaused ? '▶' : '❚❚'}
            </button>
          ) : null}

          <button
            className={`voice-panel-record-button ${isMicRecording ? 'is-recording' : ''}`}
            type="button"
            onClick={onToggleRecording}
            aria-label={isMicRecording ? 'Остановить запись' : 'Начать запись'}
          >
            {isMicRecording ? (
              // #13/полосочки: фирменный микрофон, 4 строки внутри капсулы двигаются
              // по реальному уровню сигнала (пауза — level=null, застывают статично).
              <BrandMicIcon className="voice-panel-record-icon" level={isMicPaused ? null : micLevel ?? 0} />
            ) : (
              '●'
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
