import uploadIcon from '../assets/icons/upload.png';
import { formatDate } from '../lib/format.js';
import InstallButton from './InstallButton.jsx';

function BellIcon() {
  return (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
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



export default function Topbar({
  activePage,
  isOnline,
  isUploading,
  isMicRecording,
  handleFileChange,
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
          {activePage === 'home'
            ? 'Главная'
            : activePage === 'settings'
            ? 'Настройки'
            : activePage === 'contacts'
              ? 'Контакты'
              : activePage === 'projects'
                ? 'Проекты'
                : activePage === 'tasksearch'
                  ? 'Поиск задач'
                  : 'Записи'}
          {isOnline ? null : (
            <span className="offline-badge" role="status" title="Нет подключения к сети — показаны сохранённые данные">
              Офлайн
            </span>
          )}
        </h1>
      </div>

      <div className="topbar-right">
        <div className="topbar-actions">
          {activePage === 'library' ? (
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
          ) : null}

          <InstallButton variant="compact" />

          <NotificationsMenu
            notifications={notifications}
            unreadNotificationCount={unreadNotificationCount}
            isNotificationsOpen={isNotificationsOpen}
            setIsNotificationsOpen={setIsNotificationsOpen}
            onOpenNotification={onOpenNotification}
          />
        </div>
      </div>
    </section>
  );
}
