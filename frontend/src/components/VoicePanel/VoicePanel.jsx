import Waveform from './Waveform.jsx';

export default function VoicePanel({ isOpen, onClose, isMicRecording, analyserRef, onToggleRecording, status }) {
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
            <div className="voice-panel-pulse" />
            <Waveform analyserRef={analyserRef} isActive={isMicRecording} />
            <p className="voice-panel-status">{status || 'Идёт запись...'}</p>
          </div>
        ) : (
          <div className="voice-panel-idle">
            <p className="voice-panel-status">{status || 'Готово к записи'}</p>
          </div>
        )}

        <button
          className={`voice-panel-record-button ${isMicRecording ? 'is-recording' : ''}`}
          type="button"
          onClick={onToggleRecording}
          aria-label={isMicRecording ? 'Остановить запись' : 'Начать запись'}
        >
          {isMicRecording ? '■' : '●'}
        </button>
      </section>
    </div>
  );
}
