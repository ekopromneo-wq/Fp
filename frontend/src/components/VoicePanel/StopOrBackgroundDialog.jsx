/**
 * STG-065: раньше крестик/бэкдроп панели записи просто скрывали её —
 * MediaRecorder продолжал писать молча, без индикации. Теперь закрытие панели
 * во время активной записи перехватывается этим диалогом с тремя явными
 * исходами (три исхода не умещаются в window.confirm, поэтому — как
 * ConsentDialog — отдельный компонент):
 *   - «Остановить»        → останавливаем запись как обычно (загрузка идёт)
 *   - «Записывать в фоне»  → просто закрываем панель, запись продолжается
 *     (прежнее поведение, но теперь осознанный выбор, а не случайный)
 *   - клик по фону/Escape  → закрыть диалог, ничего не менять (панель остаётся
 *     открытой) — третьего скрытого исхода нет
 */
export default function StopOrBackgroundDialog({ onStop, onBackground, onDismiss }) {
  return (
    <div
      className="stop-or-background-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stop-or-background-title"
      onClick={onDismiss}
    >
      <div className="stop-or-background-dialog" onClick={(event) => event.stopPropagation()}>
        <h2 id="stop-or-background-title">Остановить запись?</h2>
        <div className="stop-or-background-actions">
          <button className="button button-primary" type="button" onClick={onStop}>
            Остановить
          </button>
          <button className="button" type="button" onClick={onBackground}>
            Записывать в фоне
          </button>
        </div>
      </div>
    </div>
  );
}
