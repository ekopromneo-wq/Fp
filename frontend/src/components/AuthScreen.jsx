import { useState } from 'react';
import { demoEmail, demoPassword } from '../lib/api.js';

function AuthScreen({ authMode, setAuthMode, onSubmit, isSubmitting, authMessage }) {
  const [email, setEmail] = useState(demoEmail);
  const [password, setPassword] = useState(demoPassword);
  const [displayName, setDisplayName] = useState('Demo User');
  const isRegister = authMode === 'register';

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
        <p className="eyebrow">VoxMate</p>
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

        <button className="link-button" type="button" onClick={() => setAuthMode(isRegister ? 'login' : 'register')}>
          {isRegister ? 'Уже есть аккаунт' : 'Создать новый аккаунт'}
        </button>

        {authMessage ? <p className="auth-message">{authMessage}</p> : null}
      </section>
    </main>
  );
}

export default AuthScreen;
