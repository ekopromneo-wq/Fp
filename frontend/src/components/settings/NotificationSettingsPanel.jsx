const CHANNEL_OPTIONS = [
  { value: 'in_app', label: 'В приложении' },
  { value: 'email', label: 'Email' },
  { value: 'telegram', label: 'Telegram' },
];

export default function NotificationSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading }) {
  const channels = draft.channels || [];

  function toggleChannel(value) {
    setDraft((current) => {
      const currentChannels = current.channels || [];
      const isSelected = currentChannels.includes(value);

      if (isSelected) {
        return { ...current, channels: currentChannels.filter((channel) => channel !== value) };
      }

      if (currentChannels.length >= 2) {
        return current;
      }

      return { ...current, channels: [...currentChannels, value] };
    });
  }

  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Уведомления</p>
          <h2>Готовность и сбои обработки</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        {CHANNEL_OPTIONS.map((option) => {
          const isSelected = channels.includes(option.value);
          const isDisabled = !isSelected && channels.length >= 2;

          return (
            <label key={option.value} className={`settings-toggle ${isDisabled ? 'is-disabled' : ''}`}>
              <input type="checkbox" checked={isSelected} disabled={isDisabled} onChange={() => toggleChannel(option.value)} />
              {option.label}
            </label>
          );
        })}

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={Boolean(draft.dnd)}
            onChange={(event) => setDraft((current) => ({ ...current, dnd: event.target.checked }))}
          />
          Не беспокоить
        </label>

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить уведомления'}
        </button>
      </form>

      <p className="settings-note">
        Уведомляем о готовности протокола и о сбоях обработки. В приложении история хранится 90 дней независимо от
        выбранных каналов. Push-уведомления в браузере пока не подключены — планируем позже.
      </p>
    </section>
  );
}
