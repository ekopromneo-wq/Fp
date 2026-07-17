import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, demoEmail, demoPassword } from '../lib/api.js';
import InstallButton from './InstallButton.jsx';

/**
 * Кнопка входа через Telegram (US-16.1). Официальный виджет — внешний скрипт с
 * telegram.org, который рендерит кнопку и по нажатию редиректит на наш callback
 * с подписанными данными. Показывается, только если бот настроен на сервере.
 */
function TelegramLoginButton({ botUsername }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    container.innerHTML = '';
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-auth-url', `${apiBaseUrl}/api/auth/telegram/callback`);
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [botUsername]);

  return <div className="telegram-login" ref={containerRef} />;
}

function AuthScreen({
  authMode,
  setAuthMode,
  onSubmit,
  isSubmitting,
  authMessage,
  registrationOpen = true,
  oauthProviders = [],
  telegramLogin = null,
}) {
  const [email, setEmail] = useState(demoEmail);
  const [password, setPassword] = useState(demoPassword);
  const [displayName, setDisplayName] = useState('Demo User');
  // Регистрация закрыта на сервере → показываем только вход.
  const isRegister = registrationOpen && authMode === 'register';

  function handleSubmit(event) {
    event.preventDefault();
    onSubmit({
      email,
      password,
      displayName,
    });
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <p className="eyebrow">Stenogram</p>
        <h1 id="auth-title">{isRegister ? 'Создать аккаунт' : 'Вход'}</h1>
        <p className="auth-copy">Рабочая область записей доступна после входа.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister ? (
            <label>
              Имя
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}

          <label>
            Email
            <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>

          <label>
            Пароль
            <input
              value={password}
              type="password"
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </label>

          <button className="button button-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Проверяем...' : isRegister ? 'Зарегистрироваться' : 'Войти'}
          </button>
        </form>

        {/* US-16.1 (ADR-027): вход через провайдеров — показываем только
            настроенные на сервере. Ведём на бэкенд-роут (полный редирект). */}
        {oauthProviders.length || telegramLogin ? (
          <div className="oauth-buttons">
            <div className="oauth-divider"><span>или</span></div>
            {oauthProviders.map((item) => (
              <a
                key={item.provider}
                className="button button-secondary oauth-button"
                href={`${apiBaseUrl}/api/auth/oauth/${item.provider}/start`}
              >
                Войти через {item.label}
              </a>
            ))}
            {telegramLogin?.botUsername ? <TelegramLoginButton botUsername={telegramLogin.botUsername} /> : null}
          </div>
        ) : null}

        {registrationOpen ? (
          <button className="link-button" type="button" onClick={() => setAuthMode(isRegister ? 'login' : 'register')}>
            {isRegister ? 'Уже есть аккаунт' : 'Создать новый аккаунт'}
          </button>
        ) : null}

        {authMessage ? <p className="auth-message">{authMessage}</p> : null}

        <div className="auth-install">
          <InstallButton variant="full" />
        </div>
      </section>
    </main>
  );
}

export default AuthScreen;
