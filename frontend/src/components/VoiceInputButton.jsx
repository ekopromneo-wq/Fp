import { useRef, useState } from 'react';

/**
 * Push-to-talk кнопка голосового ввода (US-10.2, голосовой поиск): клик —
 * запись с микрофона, повторный клик — стоп, аудио уходит в onDictate
 * (blob → распознанный текст), результат — в onText. Тот же паттерн
 * MediaRecorder, что и надиктовка в ProtocolView, но самодостаточный: у
 * поисковой строки нет своего draft-состояния, в которое можно было бы
 * встроить чужой toggleDictate.
 */
export default function VoiceInputButton({ onDictate, onText, setStatus, title = 'Голосовой ввод' }) {
  const [isRecording, setIsRecording] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  async function handleToggle() {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (isBusy) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus?.('Голосовой ввод не поддерживается в этом браузере');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {};
      const recorder = new MediaRecorder(stream, options);
      chunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setIsRecording(false);

        if (!chunksRef.current.length) {
          return;
        }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        setIsBusy(true);
        setStatus?.('Распознаём запрос...');

        try {
          const text = await onDictate(blob);

          if (text) {
            onText(text);
          }

          setStatus?.(text ? 'Голосовой запрос распознан' : 'Не удалось распознать речь');
        } catch (error) {
          setStatus?.(error.message || 'Не удалось распознать запрос');
        } finally {
          setIsBusy(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      setStatus?.('Говорите — повторный клик остановит запись');
    } catch (error) {
      setStatus?.(error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : error.message || 'Не удалось начать запись');
    }
  }

  return (
    <button
      className={`button icon-button ${isRecording ? 'button-danger' : 'button-secondary'} voice-input-button`}
      type="button"
      onClick={handleToggle}
      disabled={isBusy}
      aria-label={isRecording ? 'Остановить голосовой ввод' : title}
      title={isRecording ? 'Остановить голосовой ввод' : title}
    >
      <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
      </svg>
    </button>
  );
}
