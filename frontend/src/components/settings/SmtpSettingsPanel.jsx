export default function SmtpSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading, hasPassword }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">SMTP</p>
          <h2>Отправка протоколов</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          SMTP host
          <input
            value={draft.host}
            onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
            placeholder="smtp.example.com"
          />
        </label>

        <label>
          Порт
          <input
            value={draft.port}
            onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value }))}
            inputMode="numeric"
            placeholder="587"
          />
        </label>

        <label className="settings-toggle">
          <input
            checked={draft.secure}
            onChange={(event) => setDraft((current) => ({ ...current, secure: event.target.checked }))}
            type="checkbox"
          />
          TLS/SSL
        </label>

        <label>
          Пользователь
          <input
            value={draft.user}
            onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))}
            placeholder="smtp-user"
          />
        </label>

        <label>
          Пароль
          <input
            value={draft.pass}
            onChange={(event) => setDraft((current) => ({ ...current, pass: event.target.value }))}
            type="password"
            placeholder={hasPassword ? 'Пароль сохранен, оставь пустым чтобы не менять' : 'Пароль SMTP'}
          />
        </label>

        <label>
          От кого
          <input
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            placeholder="Stenogram <no-reply@example.com>"
          />
        </label>

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить SMTP'}
        </button>
      </form>

      <p className="settings-note">
        Эти настройки используются для кнопки отправки протокола по Email. Если поле пароля пустое, сохраненный
        пароль не меняется.
      </p>
    </section>
  );
}
