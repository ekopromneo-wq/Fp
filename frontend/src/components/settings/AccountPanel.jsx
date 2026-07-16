import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { MEETING_TYPE_OPTIONS } from '../../lib/exporters.js';

function deviceLabel(userAgent) {
  if (!userAgent) return 'Неизвестное устройство';
  const ua = userAgent;
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Браузер';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

/**
 * Аккаунт (US-16.1/16.2/16.4): устройства и сессии, шаблон протокола по
 * умолчанию, предупреждение о согласии на запись, удаление аккаунта.
 */
export default function AccountPanel({ currentUser, onLoggedOut, setStatus }) {
  const [sessions, setSessions] = useState([]);
  const [account, setAccount] = useState({ defaultMeetingType: 'meeting', recordingConsentWarning: true });
  const [isSavingAccount, setIsSavingAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  async function loadSessions() {
    try {
      const response = await apiFetch('/api/auth/sessions');
      const data = await response.json();
      if (response.ok) setSessions(data.sessions || []);
    } catch {
      // список устройств не критичен для остального экрана
    }
  }

  useEffect(() => {
    loadSessions();
    (async () => {
      try {
        const response = await apiFetch('/api/settings/account');
        const data = await response.json();
        if (response.ok) setAccount(data.account);
      } catch {
        // настройки аккаунта останутся дефолтными
      }
    })();
  }, []);

  async function saveAccount(patch) {
    setIsSavingAccount(true);
    try {
      const response = await apiFetch('/api/settings/account', { method: 'PATCH', body: JSON.stringify(patch) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить');
      setAccount(data.account);
      setStatus('Настройки аккаунта сохранены');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsSavingAccount(false);
    }
  }

  async function revokeSession(id) {
    const response = await apiFetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
    if (response.ok) {
      setStatus('Сессия завершена');
      loadSessions();
    }
  }

  async function revokeOthers() {
    const response = await apiFetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    const data = await response.json();
    if (response.ok) {
      setStatus(`Завершено сессий: ${data.revoked}`);
      loadSessions();
    }
  }

  async function deleteAccount() {
    if (!deletePassword) {
      setStatus('Введите пароль для подтверждения удаления');
      return;
    }

    if (!window.confirm('Удалить аккаунт со всеми записями, проектами и задачами? Это действие необратимо.')) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await apiFetch('/api/auth/delete-account', { method: 'POST', body: JSON.stringify({ password: deletePassword }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось удалить аккаунт');
      onLoggedOut();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Аккаунт</p>
          <h2>Устройства, шаблон и удаление</h2>
        </div>
      </div>

      <div className="account-block">
        <h3>Шаблон протокола по умолчанию</h3>
        <label className="account-inline">
          <select
            value={account.defaultMeetingType}
            onChange={(event) => saveAccount({ defaultMeetingType: event.target.value })}
            disabled={isSavingAccount}
          >
            {MEETING_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={account.recordingConsentWarning !== false}
            onChange={(event) => saveAccount({ recordingConsentWarning: event.target.checked })}
            disabled={isSavingAccount}
          />
          Предупреждать о согласии участников перед началом записи (152-ФЗ)
        </label>
      </div>

      <div className="account-block">
        <div className="home-block-head">
          <h3>Устройства и сессии</h3>
          {sessions.length > 1 ? (
            <button className="link-button" type="button" onClick={revokeOthers}>
              Завершить все, кроме текущей
            </button>
          ) : null}
        </div>
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className="session-row">
              <div>
                <strong>{deviceLabel(session.userAgent)}</strong>
                {session.current ? <span className="session-current">текущее</span> : null}
                <span className="muted-text">
                  {session.ip ? `${session.ip} · ` : ''}активно {formatDate(session.lastSeenAt)}
                </span>
              </div>
              {!session.current ? (
                <button className="button button-danger" type="button" onClick={() => revokeSession(session.id)}>
                  Завершить
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="account-block account-danger">
        <h3>Удаление аккаунта</h3>
        <p className="muted-text">
          Аккаунт {currentUser?.email}, все записи, проекты, задачи и аудио удаляются безвозвратно. Введите пароль для
          подтверждения.
        </p>
        <div className="account-inline">
          <input
            type="password"
            value={deletePassword}
            onChange={(event) => setDeletePassword(event.target.value)}
            placeholder="Пароль аккаунта"
          />
          <button className="button button-danger" type="button" onClick={deleteAccount} disabled={isDeleting}>
            {isDeleting ? 'Удаляем...' : 'Удалить аккаунт'}
          </button>
        </div>
      </div>
    </section>
  );
}
