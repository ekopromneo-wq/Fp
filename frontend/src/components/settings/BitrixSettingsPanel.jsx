export default function BitrixSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading, hasWebhook }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Битрикс24</p>
          <h2>Создание задач в Битрикс24</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          Входящий вебхук
          <input
            value={draft.webhookUrl}
            onChange={(event) => setDraft((current) => ({ ...current, webhookUrl: event.target.value }))}
            type="password"
            placeholder={hasWebhook ? 'Вебхук сохранен, оставь пустым чтобы не менять' : 'https://portal.bitrix24.ru/rest/1/xxxx/'}
          />
        </label>

        <label>
          Ответственный по умолчанию (ID)
          <input
            value={draft.defaultResponsibleId}
            onChange={(event) => setDraft((current) => ({ ...current, defaultResponsibleId: event.target.value }))}
            placeholder="1"
          />
        </label>

        <label>
          Группа/проект (ID, опционально)
          <input
            value={draft.defaultGroupId}
            onChange={(event) => setDraft((current) => ({ ...current, defaultGroupId: event.target.value }))}
            placeholder=""
          />
        </label>

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить Битрикс24'}
        </button>
      </form>

      <p className="settings-note">
        Вебхук создаётся в Битрикс24: Приложения → Разработчикам → Входящий вебхук, с правом на раздел «Задачи».
      </p>
    </section>
  );
}
