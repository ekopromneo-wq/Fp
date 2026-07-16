import { useState } from 'react';
import { apiFetch } from '../../lib/api.js';

/**
 * Привязка личного чата к аккаунту (US-14.1): код живёт 15 минут, пользователь
 * шлёт его боту, дальше бот принимает голосовые/файлы/ссылки и возвращает
 * протокол с задачами прямо в чат.
 */
function BotLinkSection() {
  const [link, setLink] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  async function requestCode() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await apiFetch('/api/telegram/link-code', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось получить код привязки');
      }

      setLink(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="telegram-link-section">
      <h3>Бот-помощник в личном чате</h3>
      <p className="muted-text">
        Пришлите боту голосовое, аудио, видео или ссылку — он вернёт протокол и задачи прямо в чат, без открытия
        приложения.
      </p>

      <button className="button button-secondary" type="button" onClick={requestCode} disabled={isLoading}>
        {isLoading ? 'Получаем код...' : link ? 'Новый код привязки' : 'Привязать чат с ботом'}
      </button>

      {link ? (
        <div className="telegram-link-code">
          <strong>{link.code}</strong>
          <span className="muted-text">
            Отправьте этот код вашему боту в личном чате в течение 15 минут.
            {link.botConfigured ? '' : ' Сначала укажите токен бота выше — без него боту не с чем работать.'}
          </span>
        </div>
      ) : null}

      {error ? <p className="task-bitrix-error">{error}</p> : null}
    </div>
  );
}

export default function TelegramSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading, hasToken }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Telegram</p>
          <h2>Отправка протоколов в Telegram</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          Токен бота
          <input
            value={draft.botToken}
            onChange={(event) => setDraft((current) => ({ ...current, botToken: event.target.value }))}
            type="password"
            placeholder={hasToken ? 'Токен сохранен, оставь пустым чтобы не менять' : '123456:AA...'}
          />
        </label>

        <label>
          Chat ID по умолчанию
          <input
            value={draft.chatId}
            onChange={(event) => setDraft((current) => ({ ...current, chatId: event.target.value }))}
            placeholder="636211143"
          />
        </label>

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить Telegram'}
        </button>
      </form>

      <BotLinkSection />

      <p className="settings-note">
        Токен получают у @BotFather. Chat ID — это чат, куда бот уже написал хотя бы раз (можно переопределить при
        отправке конкретной записи).
      </p>
    </section>
  );
}
