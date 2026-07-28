import { useState } from 'react';
import Waveform from './Waveform.jsx';
import BrandMicIcon from '../BrandMicIcon.jsx';
import CancelRecordingDialog from './CancelRecordingDialog.jsx';
import { formatDuration } from '../../lib/format.js';
import useEscapeKey from '../../hooks/useEscapeKey.js';

// STG-005: до этой длительности отменять нечего - пара секунд в начале
// записи не жалко потерять, лишний диалог с выбором только бы мешал.
const MEANINGFUL_DURATION_SECONDS = 3;

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
  onCancelRecording,
  status,
}) {
  const [showCancelChoice, setShowCancelChoice] = useState(false);

  function handleCancelClick() {
    if (micDuration >= MEANINGFUL_DURATION_SECONDS) {
      setShowCancelChoice(true);
      return;
    }

    if (window.confirm('Отменить запись без сохранения?')) {
      onCancelRecording();
    }
  }

  // STG-062: Escape закрывает панель записи, как и клик по крестику/фону.
  useEscapeKey(() => {
    if (isOpen) onClose();
  });

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {showCancelChoice ? (
        <CancelRecordingDialog
          duration={micDuration}
          onDismiss={() => setShowCancelChoice(false)}
          onDelete={() => {
            setShowCancelChoice(false);
            onCancelRecording();
          }}
          onSave={() => {
            setShowCancelChoice(false);
            // "Сохранить как есть" - обычная остановка: тот же путь, что и
            // кнопка "Остановить", запись уходит в очередь на обработку.
            onToggleRecording();
          }}
        />
      ) : null}

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
          {isMicRecording ? (
            <button
              className="button button-secondary voice-panel-cancel-button"
              type="button"
              onClick={handleCancelClick}
              aria-label="Отменить запись"
            >
              Отменить
            </button>
          ) : null}

          {isMicRecording && canPauseMicRecording ? (
            // STG-047: на паузе именно «Продолжить» - самое вероятное следующее
            // действие, но кнопка была маленькой серой рядом с крупной красной
            // «Остановить» - легко перепутать или не заметить. На паузе меняем
            // приоритет: «Продолжить» становится крупной акцентной.
            <button
              className={`voice-panel-pause-button ${isMicPaused ? 'is-paused' : ''}`}
              type="button"
              onClick={onTogglePause}
              aria-label={isMicPaused ? 'Продолжить запись' : 'Поставить на паузу'}
            >
              {isMicPaused ? '▶' : '❚❚'}
            </button>
          ) : null}

          <button
            className={`voice-panel-record-button ${isMicRecording ? 'is-recording' : ''} ${isMicPaused ? 'is-secondary' : ''}`}
            type="button"
            onClick={onToggleRecording}
            aria-label={isMicRecording ? 'Остановить запись' : 'Начать запись'}
          >
            {isMicRecording ? (
              // STG-070: раньше во время записи кнопка показывала тот же
              // анимированный микрофон, что и общий индикатор выше - нет
              // стандартной иконки остановки (квадрат ■), которую ожидает
              // пользователь по ментальной модели плеера/диктофона.
              <span className="voice-panel-stop-square" aria-hidden="true" />
            ) : (
              // #13: фирменный микрофон на стойке - тот же знак, что и на FAB
              // главного экрана (BottomNav), для единообразия "нажми, чтобы начать".
              <BrandMicIcon className="voice-panel-record-icon" level={0} />
            )}
          </button>
        </div>
        </section>
      </div>
    </>
  );
}
