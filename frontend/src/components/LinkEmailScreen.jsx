import { useState } from 'react';
import InstallButton from './InstallButton.jsx';

// ADR-034: шаг «подтвердите email». Пользователь вошёл через провайдера, который
// не дал пригодного email (Telegram/ВК) или чей email уже занят. Аккаунт без
// первичного email не создаём — здесь он вводит email, чтобы завершить вход.
//   - новый email → создаётся аккаунт (пароль по желанию);
//   - занятый email → нужен пароль от того аккаунта, чтобы привязать вход
//     (сервер вернёт needsPassword и мы раскроем поле пароля).
function LinkEmailScreen({ providerLabel, onSubmit, isSubmitting, message, needsPassword }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    onSubmit({ email, password, displayName });
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="link-email-title">
        <p className="eyebrow">Stenogram</p>
        <h1 id="link-email-title">Подтвердите email</h1>
        <p className="auth-copy">
          {providerLabel ? `Вход через ${providerLabel} почти готов. ` : ''}
          Укажите email — он станет основным способом восстановления доступа.
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>

          {/* Пароль: для нового аккаунта — по желанию (можно и без него, вход через
              провайдера уже привязан); для занятого email — обязателен как
              доказательство владения (needsPassword от сервера). */}
          <label>
            {needsPassword ? 'Пароль от аккаунта' : 'Пароль (по желанию)'}
            <input
              value={password}
              type="password"
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={needsPassword ? 'current-password' : 'new-password'}
              minLength={needsPassword ? undefined : 6}
              required={needsPassword}
            />
          </label>

          {!needsPassword ? (
            <label>
              Имя (по желанию)
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}

          <button className="button button-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Проверяем...' : 'Завершить вход'}
          </button>
        </form>

        {message ? <p className="auth-message">{message}</p> : null}

        <div className="auth-install">
          <InstallButton variant="full" />
        </div>
      </section>
    </main>
  );
}

export default LinkEmailScreen;
