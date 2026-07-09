import uploadIcon from '../assets/icons/upload.png';
import microphoneIcon from '../assets/icons/microphone.png';
import refreshIcon from '../assets/icons/refresh.png';
import settingsIcon from '../assets/icons/settings.png';

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
