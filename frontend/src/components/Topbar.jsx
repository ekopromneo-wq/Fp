import uploadIcon from '../assets/icons/upload.png';
import microphoneIcon from '../assets/icons/microphone.png';
import refreshIcon from '../assets/icons/refresh.png';
import settingsIcon from '../assets/icons/settings.png';
import { formatDate, formatDuration } from '../lib/format.js';

function BellIcon() {
  return (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
    </svg>
  );
}

function NotificationsMenu({ notifications, unreadNotificationCount, isNotificationsOpen, setIsNotificationsOpen, onOpenNotification }) {
  return (
    <div className="notifications-menu">
      <button
        className="button icon-button button-secondary"
        type="button"
        onClick={() => setIsNotificationsOpen((current) => !current)}
        aria-label="Уведомления"
        title="Уведомления"
      >
        <BellIcon />
        {unreadNotificationCount > 0 ? <span className="notifications-badge">{unreadNotificationCount}</span> : null}
      </button>

      {isNotificationsOpen ? (
        <div className="notifications-dropdown" role="menu">
          {notifications.length === 0 ? (
            <p className="muted-text notifications-empty">Уведомлений пока нет</p>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                className={`notifications-item ${notification.readAt ? '' : 'is-unread'}`}
                onClick={() => onOpenNotification(notification)}
              >
                <strong>{notification.title}</strong>
                <span>{notification.message}</span>
                <span className="notifications-item-date">{formatDate(notification.createdAt)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function PauseResumeIcon({ isPaused }) {
  return isPaused ? (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7Z" />
    </svg>
  ) : (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function ThemeIcon({ theme }) {
  return theme === 'dark' ? (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  ) : (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export default function Topbar({
  activePage,
  setActivePage,
  currentUser,
  isOnline,
  isUploading,
  isMicRecording,
  isMicPaused,
  canPauseMicRecording,
  micLevel,
  micDuration,
  isMicLevelLow,
  handleFileChange,
  handleMicRecordingToggle,
  handleMicPauseToggle,
  loadRecordings,
  isLoading,
  handleLogout,
  theme,
  onToggleTheme,
  notifications,
  unreadNotificationCount,
  isNotificationsOpen,
  setIsNotificationsOpen,
  onOpenNotification,
}) {
  return (
    <section className="topbar" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">VoxMate</p>
        <h1 id="page-title">
          {activePage === 'settings' ? 'Настройки' : activePage === 'contacts' ? 'Контакты' : 'Записи'}
          {isOnline ? null : (
            <span className="offline-badge" role="status" title="Нет подключения к сети — показаны сохранённые данные">
              Офлайн
            </span>
          )}
        </h1>
      </div>

      <div className="topbar-right">
        <div className="user-chip">
          <strong>{currentUser.displayName}</strong>
          <span>{currentUser.email}</span>
        </div>

        <div className="actions">
          {activePage !== 'library' ? (
            <button className="button button-secondary" type="button" onClick={() => setActivePage('library')}>
              Записи
            </button>
          ) : (
            <>
              <label
                className={`button icon-button icon-button-ghost ${isUploading || isMicRecording ? 'is-disabled' : ''}`}
                aria-label="Загрузить запись"
                title="Загрузить запись"
              >
                <input
                  type="file"
                  accept="audio/*,video/*,.webm,.mp3,.wav,.m4a,.ogg,.mp4,.mov,.mkv"
                  onChange={handleFileChange}
                  disabled={isUploading || isMicRecording}
                />
                <img className="icon-button-image" src={uploadIcon} alt="" />
              </label>

              <span className="mic-record-group">
                <button
                  className={`button icon-button ${isMicRecording ? 'button-danger' : 'button-secondary'}`}
                  type="button"
                  onClick={handleMicRecordingToggle}
                  disabled={isUploading}
                  aria-label={isMicRecording ? 'Остановить запись' : 'Записать с микрофона'}
                  title={isMicRecording ? 'Остановить запись' : 'Записать с микрофона'}
                  style={
                    isMicRecording && !isMicPaused
                      ? { background: `linear-gradient(to top, #f4c430 ${micLevel * 100}%, #fff7f5 ${micLevel * 100}%)` }
                      : undefined
                  }
                >
                  <img className="icon-button-image" src={microphoneIcon} alt="" />
                </button>

                {isMicRecording && canPauseMicRecording ? (
                  <button
                    className="button icon-button button-secondary"
                    type="button"
                    onClick={handleMicPauseToggle}
                    aria-label={isMicPaused ? 'Продолжить запись' : 'Поставить на паузу'}
                    title={isMicPaused ? 'Продолжить запись' : 'Поставить на паузу'}
                  >
                    <PauseResumeIcon isPaused={isMicPaused} />
                  </button>
                ) : null}

                {isMicRecording ? (
                  <span className={`mic-record-duration ${isMicPaused ? 'is-paused' : ''}`} aria-live="polite">
                    {isMicPaused ? 'Пауза · ' : ''}
                    {formatDuration(micDuration)}
                  </span>
                ) : null}

                {isMicRecording && isMicLevelLow && !isMicPaused ? (
                  <span className="mic-record-warning" role="alert" title="Тихо или микрофон не слышно — проверьте звук">
                    ⚠ звук тихий
                  </span>
                ) : null}
              </span>

              <button
                className="button button-secondary icon-button"
                type="button"
                onClick={() => loadRecordings()}
                disabled={isLoading || isUploading || isMicRecording}
                aria-label="Обновить"
                title="Обновить"
              >
                <img className="icon-button-image" src={refreshIcon} alt="" />
              </button>
            </>
          )}

          <NotificationsMenu
            notifications={notifications}
            unreadNotificationCount={unreadNotificationCount}
            isNotificationsOpen={isNotificationsOpen}
            setIsNotificationsOpen={setIsNotificationsOpen}
            onOpenNotification={onOpenNotification}
          />

          <button
            className="button icon-button button-secondary"
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          >
            <ThemeIcon theme={theme} />
          </button>

          <button
            className={`button icon-button ${activePage === 'contacts' ? 'button-primary' : 'button-secondary'}`}
            type="button"
            onClick={() => setActivePage('contacts')}
            aria-label="Контакты"
            title="Контакты"
          >
            <ContactsIcon />
          </button>

          <button
            className={`button icon-button ${activePage === 'settings' ? 'button-primary' : 'button-secondary'}`}
            type="button"
            onClick={() => setActivePage('settings')}
            aria-label="Настройки"
            title="Настройки"
          >
            <img className="icon-button-image" src={settingsIcon} alt="" />
          </button>

          <button className="button button-secondary" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </div>
    </section>
  );
}
