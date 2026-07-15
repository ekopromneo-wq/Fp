export default function SendSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Отправка</p>
          <h2>Как рассылать протоколы и задачи</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          Канал по умолчанию
          <select
            value={draft.defaultChannel || 'email'}
            onChange={(event) => setDraft((current) => ({ ...current, defaultChannel: event.target.value }))}
          >
            <option value="email">Email</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={draft.preview !== false}
            onChange={(event) => setDraft((current) => ({ ...current, preview: event.target.checked }))}
          />
          Показывать предпросмотр перед отправкой
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={draft.attachDocx !== false}
            onChange={(event) => setDraft((current) => ({ ...current, attachDocx: event.target.checked }))}
          />
          По умолчанию прикладывать Word-файл к письму
        </label>

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить отправку'}
        </button>
      </form>

      <p className="settings-note">
        Каждая отправка попадает в журнал доставки в карточке встречи. Временные сбои канала повторяются автоматически до
        трёх раз, после чего предлагается другой канал. Автоотправка по правилам — отдельная функция, её пока нет.
      </p>
    </section>
  );
}
