import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { MEETING_TYPE_OPTIONS } from '../../lib/exporters.js';

// US-16.3: отдельные согласия на обработку и их подписи.
const PROCESSING_CONSENT_LABELS = [
  ['recording', 'Запись встреч'],
  ['transcription', 'Транскрипция (распознавание речи)'],
  ['ai_analysis', 'AI-анализ: протокол, задачи, краткое содержание'],
  ['cross_border', 'Трансграничная передача данных облачным сервисам'],
];

const CONSENT_TYPE_NAMES = {
  recording: 'Запись',
  transcription: 'Транскрипция',
  ai_analysis: 'AI-анализ',
  cross_border: 'Трансграничная передача',
  participant_notice: 'Предупреждение участников',
  support_access: 'Доступ поддержки',
};

const CONSENT_ACTION_NAMES = { grant: 'выдано', revoke: 'отозвано', decline: 'отказ' };

const CONSENT_MODE_NAMES = {
  consented: 'все согласны',
  excluded: 'без участника',
  override: 'несмотря на отказ',
};

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
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [account, setAccount] = useState({ defaultMeetingType: 'meeting', recordingConsentWarning: true });
  const [isSavingAccount, setIsSavingAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [consents, setConsents] = useState(null);
  const [consentHistory, setConsentHistory] = useState(null);

  async function loadSessions() {
    try {
      const response = await apiFetch('/api/auth/sessions');
      const data = await response.json();
      if (response.ok) setSessions(data.sessions || []);
    } catch {
      // список устройств не критичен для остального экрана
    }
  }

  async function loadConsents() {
    try {
      const response = await apiFetch('/api/settings/consents');
      const data = await response.json();
      if (response.ok) setConsents(data);
    } catch {
      // блок согласий не критичен для остального экрана
    }
  }

  useEffect(() => {
    loadSessions();
    loadConsents();
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

  async function toggleProcessingConsent(type, granted) {
    try {
      const response = await apiFetch('/api/settings/consents', {
        method: 'PATCH',
        body: JSON.stringify({ type, granted }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить согласие');
      setConsents((prev) => (prev ? { ...prev, processing: data.processing } : prev));
      setStatus('Согласие обновлено');
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function toggleSupportAccess(granted) {
    try {
      const response = await apiFetch('/api/settings/support-access', {
        method: 'POST',
        body: JSON.stringify({ granted }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось изменить доступ поддержки');
      setConsents((prev) => (prev ? { ...prev, supportAccess: data.supportAccess } : prev));
      setStatus(granted ? 'Доступ поддержки разрешён' : 'Доступ поддержки отозван');
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function loadConsentHistory() {
    try {
      const response = await apiFetch('/api/consent/history');
      const data = await response.json();
      if (response.ok) setConsentHistory(data.events || []);
    } catch {
      setConsentHistory([]);
    }
  }

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
        <h3>Приватность и согласия (152-ФЗ)</h3>
        <p className="muted-text">
          Отдельные согласия на обработку. Изменения фиксируются в журнале как доказательство.
        </p>

        {consents ? (
          <>
            {PROCESSING_CONSENT_LABELS.map(([type, label]) => (
              <label className="settings-toggle" key={type} title={consents.texts?.[type] || ''}>
                <input
                  type="checkbox"
                  checked={Boolean(consents.processing?.[type]?.granted)}
                  onChange={(event) => toggleProcessingConsent(type, event.target.checked)}
                />
                {label}
              </label>
            ))}

            <label className="settings-toggle" title={consents.texts?.support_access || ''}>
              <input
                type="checkbox"
                checked={Boolean(consents.supportAccess?.granted)}
                onChange={(event) => toggleSupportAccess(event.target.checked)}
              />
              Разрешить службе поддержки доступ к содержимому моих встреч
            </label>

            {consentHistory === null ? (
              <button className="link-button" type="button" onClick={loadConsentHistory}>
                Показать журнал согласий
              </button>
            ) : (
              <ul className="session-list">
                {consentHistory.length === 0 ? (
                  <li className="muted-text">Записей пока нет</li>
                ) : (
                  consentHistory.slice(0, 30).map((event) => (
                    <li key={event.id} className="session-row">
                      <div>
                        <strong>{CONSENT_TYPE_NAMES[event.consentType] || event.consentType}</strong>
                        <span className="muted-text">
                          {CONSENT_ACTION_NAMES[event.action] || event.action}
                          {event.detail?.mode ? ` · ${CONSENT_MODE_NAMES[event.detail.mode] || event.detail.mode}` : ''}
                          {' · '}
                          {formatDate(event.createdAt)}
                        </span>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="muted-text">Загрузка…</p>
        )}
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
          {(showAllSessions ? sessions : sessions.slice(0, 5)).map((session) => (
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
        {sessions.length > 5 ? (
          <button className="link-button" type="button" onClick={() => setShowAllSessions((value) => !value)}>
            {showAllSessions ? 'Свернуть' : `Показать все (${sessions.length})`}
          </button>
        ) : null}
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
