import uploadIcon from '../assets/icons/upload.png';
import microphoneIcon from '../assets/icons/microphone.png';
import refreshIcon from '../assets/icons/refresh.png';
import settingsIcon from '../assets/icons/settings.png';

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
  isUploading,
  isMicRecording,
  micLevel,
  handleFileChange,
  handleMicRecordingToggle,
  loadRecordings,
  isLoading,
  handleLogout,
  theme,
  onToggleTheme,
}) {
  return (
    <section className="topbar" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">VoxMate</p>
        <h1 id="page-title">{activePage === 'settings' ? 'Настройки' : 'Записи'}</h1>
      </div>

      <div className="topbar-right">
        <div className="user-chip">
          <strong>{currentUser.displayName}</strong>
          <span>{currentUser.email}</span>
        </div>

        <div className="actions">
          {activePage === 'settings' ? (
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

              <button
                className={`button icon-button ${isMicRecording ? 'button-danger' : 'button-secondary'}`}
                type="button"
                onClick={handleMicRecordingToggle}
                disabled={isUploading}
                aria-label={isMicRecording ? 'Остановить запись' : 'Записать с микрофона'}
                title={isMicRecording ? 'Остановить запись' : 'Записать с микрофона'}
                style={
                  isMicRecording
                    ? { background: `linear-gradient(to top, #f4c430 ${micLevel * 100}%, #fff7f5 ${micLevel * 100}%)` }
                    : undefined
                }
              >
                <img className="icon-button-image" src={microphoneIcon} alt="" />
              </button>

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
