/**
 * Шаг мастера обработки записи (Фаза 1 пошагового экрана). Заголовок-аккордеон
 * со статусом (✓ готов / ● текущий / ○ позже) и раскрываемым телом. Заблокированный
 * шаг (нет предусловия, напр. нет стенограммы) не раскрывается и показывает подсказку.
 */
export default function StepCard({ n, title, state, summaryText, open, onToggle, lockedHint, children }) {
  const locked = state === 'locked';
  const marker = state === 'done' ? '✓' : state === 'current' ? '●' : '○';

  return (
    <section className={`step-card is-${state}${open && !locked ? ' is-open' : ''}`}>
      <button
        type="button"
        className="step-head"
        onClick={locked ? undefined : onToggle}
        aria-expanded={locked ? undefined : open}
        disabled={locked}
      >
        <span className="step-marker" aria-hidden="true">{marker}</span>
        <span className="step-n">{n}</span>
        <span className="step-title">{title}</span>
        {summaryText ? <span className="step-summary">{summaryText}</span> : null}
        <span className="step-tail">{locked ? (lockedHint || 'позже') : open ? '⌃' : '⌄'}</span>
      </button>
      {open && !locked ? <div className="step-body">{children}</div> : null}
    </section>
  );
}
