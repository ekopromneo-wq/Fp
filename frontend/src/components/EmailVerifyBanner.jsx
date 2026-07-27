import { useState } from 'react';

// STG-029 (решение владельца 27.07): мягкий гейт — ничего не блокирует,
// только напоминает. Скрывается на текущую сессию по крестику (не навсегда —
// при следующем входе, пока email не подтверждён, появится снова).
export default function EmailVerifyBanner({ email, onResend }) {
  const [isSending, setIsSending] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [sentMessage, setSentMessage] = useState('');

  if (isDismissed) {
    return null;
  }

  async function handleResend() {
    setIsSending(true);
    setSentMessage('');
    try {
      await onResend();
      setSentMessage('Письмо отправлено повторно');
    } catch (error) {
      setSentMessage(error.message || 'Не удалось отправить письмо');
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="email-verify-banner" role="status">
      <span>
        Подтвердите email{email ? ` (${email})` : ''} — мы отправили ссылку при регистрации.
        {sentMessage ? ` ${sentMessage}.` : ''}
      </span>
      <div className="email-verify-banner-actions">
        <button className="button button-secondary" type="button" onClick={handleResend} disabled={isSending}>
          {isSending ? 'Отправляем...' : 'Отправить письмо ещё раз'}
        </button>
        <button
          className="button icon-button button-secondary"
          type="button"
          onClick={() => setIsDismissed(true)}
          aria-label="Скрыть"
          title="Скрыть до следующего входа"
        >
          ✕
        </button>
      </div>
    </section>
  );
}
