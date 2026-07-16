import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

const ERROR_TARGETS = [
  { value: 'transcript', label: 'Ошибка в стенограмме' },
  { value: 'task', label: 'Пропущена или неверная задача' },
  { value: 'protocol', label: 'Ошибка в протоколе' },
  { value: 'other', label: 'Другое' },
];

/**
 * Обратная связь по записи (US-18.3): сообщение об ошибке (стенограмма/задача/
 * протокол) и оценка результата 1-5 с опциональным комментарием и согласием на
 * использование записи для улучшения.
 */
export default function FeedbackWidget({ recordingId, setStatus }) {
  const [mode, setMode] = useState(null); // null | 'error' | 'rating'
  const [target, setTarget] = useState('transcript');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [allowTraining, setAllowTraining] = useState(false);
  const [isSending, setIsSending] = useState(false);

  function reset() {
    setMode(null);
    setTarget('transcript');
    setRating(0);
    setComment('');
    setAllowTraining(false);
  }

  async function submit() {
    if (mode === 'rating' && !rating) {
      setStatus('Поставьте оценку от 1 до 5');
      return;
    }

    if (mode === 'error' && !comment.trim()) {
      setStatus('Опишите, что не так');
      return;
    }

    setIsSending(true);

    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          kind: mode === 'error' ? 'error_report' : 'rating',
          recordingId,
          target: mode === 'error' ? target : undefined,
          rating: mode === 'rating' ? rating : undefined,
          comment: comment.trim() || undefined,
          allowTraining,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить обратную связь');
      }

      setStatus('Спасибо! Обратная связь отправлена');
      reset();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="detail-section feedback-widget">
      <h3>Обратная связь</h3>

      {!mode ? (
        <div className="feedback-actions">
          <button className="button button-secondary" type="button" onClick={() => setMode('error')}>
            Сообщить об ошибке
          </button>
          <button className="button button-secondary" type="button" onClick={() => setMode('rating')}>
            Оценить результат
          </button>
        </div>
      ) : null}

      {mode === 'error' ? (
        <div className="feedback-form">
          <label>
            Что не так
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {ERROR_TARGETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Опишите проблему" />
        </div>
      ) : null}

      {mode === 'rating' ? (
        <div className="feedback-form">
          <div className="feedback-stars" role="radiogroup" aria-label="Оценка результата">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className={`feedback-star ${value <= rating ? 'is-active' : ''}`}
                onClick={() => setRating(value)}
                aria-label={`${value} из 5`}
                aria-pressed={value === rating}
              >
                ★
              </button>
            ))}
          </div>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={2} placeholder="Комментарий (необязательно)" />
        </div>
      ) : null}

      {mode ? (
        <>
          <label className="settings-toggle feedback-consent">
            <input type="checkbox" checked={allowTraining} onChange={(event) => setAllowTraining(event.target.checked)} />
            Разрешаю использовать эту запись для улучшения качества
          </label>
          <div className="feedback-actions">
            <button className="button button-primary" type="button" onClick={submit} disabled={isSending}>
              {isSending ? 'Отправляем...' : 'Отправить'}
            </button>
            <button className="button button-secondary" type="button" onClick={reset} disabled={isSending}>
              Отмена
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
