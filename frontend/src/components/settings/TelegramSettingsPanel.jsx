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

      <p className="settings-note">
        Токен получают у @BotFather. Chat ID — это чат, куда бот уже написал хотя бы раз (можно переопределить при
        отправке конкретной записи).
      </p>
    </section>
  );
}
