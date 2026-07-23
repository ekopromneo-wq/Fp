import { useState } from 'react';
import { formatDuration } from '../lib/format.js';

/**
 * Нижняя навигация (Bottom-Heavy / FABar по дизайн-системе): основные разделы в
 * зоне большого пальца, крупная центральная кнопка записи, второстепенное — в
 * листе «Ещё». Заменяет прежний ряд одинаковых иконок в топбаре.
 */
function NavIcon({ name }) {
  const paths = {
    home: (
      <>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5" />
      </>
    ),
    library: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 4v5M16 4v5" />
      </>
    ),
    tasks: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.35-4.35M8.5 11l1.8 1.8 3.2-3.6" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </>
    ),
  };

  return (
    <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

const MORE_ITEMS = [
  { page: 'projects', label: 'Проекты' },
  { page: 'contacts', label: 'Контакты' },
  { page: 'settings', label: 'Настройки' },
];

export default function BottomNav({
  activePage,
  setActivePage,
  onRecordToggle,
  onPauseToggle,
  isMicRecording,
  isMicPaused,
  canPauseMicRecording,
  micLevel,
  micDuration,
  isMicLevelLow,
  isUploading,
  theme,
  onToggleTheme,
  onLogout,
}) {
  const [isMoreOpen, setIsMoreOpen] = useState(false);

  function go(page) {
    setIsMoreOpen(false);
    setActivePage(page);
  }

  const moreActive = MORE_ITEMS.some((item) => item.page === activePage);

  return (
    <>
      {isMoreOpen ? (
        <div className="bottom-sheet-overlay" onClick={() => setIsMoreOpen(false)}>
          <div className="bottom-sheet" role="menu" onClick={(event) => event.stopPropagation()}>
            <div className="bottom-sheet-handle" />
            {MORE_ITEMS.map((item) => (
              <button
                key={item.page}
                type="button"
                className={`bottom-sheet-item ${activePage === item.page ? 'is-active' : ''}`}
                onClick={() => go(item.page)}
              >
                {item.label}
              </button>
            ))}
            <button type="button" className="bottom-sheet-item" onClick={onToggleTheme}>
              {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            </button>
            <button type="button" className="bottom-sheet-item is-danger" onClick={onLogout}>
              Выйти
            </button>
          </div>
        </div>
      ) : null}

      <nav className="bottom-nav" aria-label="Основная навигация">
        <button
          type="button"
          className={`bottom-nav-item ${activePage === 'home' ? 'is-active' : ''}`}
          onClick={() => go('home')}
          aria-label="Главная"
        >
          <NavIcon name="home" />
          <span>Главная</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-item ${activePage === 'library' ? 'is-active' : ''}`}
          onClick={() => go('library')}
          aria-label="Встречи"
        >
          <NavIcon name="library" />
          <span>Встречи</span>
        </button>

        {/* Центральная кнопка записи (FAB). Во время записи — состояние с уровнем
            и длительностью; тап останавливает. */}
        <div className="bottom-nav-fab-slot">
          <button
            type="button"
            className={`bottom-nav-fab ${isMicRecording ? 'is-recording' : ''}`}
            onClick={onRecordToggle}
            disabled={isUploading}
            aria-label={isMicRecording ? 'Остановить запись' : 'Записать встречу'}
            style={
              isMicRecording && !isMicPaused
                ? { background: `linear-gradient(to top, var(--accent-warning) ${Math.round(micLevel * 100)}%, var(--accent-primary) ${Math.round(micLevel * 100)}%)` }
                : undefined
            }
          >
            {isMicRecording ? (
              <span className="bottom-nav-fab-rec">
                <span className="bottom-nav-fab-square" />
                <span className="bottom-nav-fab-time">{formatDuration(micDuration)}</span>
              </span>
            ) : (
              /* #13: фирменный знак — микрофон с 4 строками стенограммы. */
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="5" height="9" rx="2.5" />
                <path d="M3 10.5a3.5 3.5 0 0 0 7 0M6.5 14v3.5" />
                <path d="M13 5h8M13 9h8M13 13h8M13 17h6" />
              </svg>
            )}
          </button>
          {isMicRecording && canPauseMicRecording ? (
            <button type="button" className="bottom-nav-pause" onClick={onPauseToggle} aria-label={isMicPaused ? 'Продолжить' : 'Пауза'}>
              {isMicPaused ? '▶' : '⏸'}
            </button>
          ) : null}
          {isMicRecording && isMicLevelLow && !isMicPaused ? <span className="bottom-nav-low" role="alert">тихо</span> : null}
        </div>

        <button
          type="button"
          className={`bottom-nav-item ${activePage === 'tasksearch' ? 'is-active' : ''}`}
          onClick={() => go('tasksearch')}
          aria-label="Задачи"
        >
          <NavIcon name="tasks" />
          <span>Задачи</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-item ${isMoreOpen || moreActive ? 'is-active' : ''}`}
          onClick={() => setIsMoreOpen((value) => !value)}
          aria-label="Ещё"
          aria-expanded={isMoreOpen}
        >
          <NavIcon name="more" />
          <span>Ещё</span>
        </button>
      </nav>
    </>
  );
}
