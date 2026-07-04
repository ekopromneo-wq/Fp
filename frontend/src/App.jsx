import { useEffect, useMemo, useState } from 'react';
import './App.css';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

function formatDate(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatFileSize(bytes) {
  if (!bytes) {
    return 'без файла';
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function App() {
  const [recordings, setRecordings] = useState([]);
  const [status, setStatus] = useState('Загружаем записи...');
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const hasRecordings = recordings.length > 0;
  const sortedRecordings = useMemo(() => recordings, [recordings]);

  async function loadRecordings() {
    setIsLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings`);

      if (!response.ok) {
        throw new Error('Не удалось получить список записей');
      }

      const data = await response.json();
      setRecordings(data.recordings || []);
      setStatus('');
    } catch (error) {
      setStatus(error.message || 'Backend недоступен');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadRecordings();
  }, []);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setIsUploading(true);
    setStatus(`Загружаем ${file.name}...`);

    try {
      const createResponse = await fetch(`${apiBaseUrl}/api/recordings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, '') || file.name,
          source: 'frontend-upload',
        }),
      });

      if (!createResponse.ok) {
        throw new Error('Не удалось создать запись');
      }

      const createData = await createResponse.json();
      const formData = new FormData();
      formData.append('file', file);

      const uploadResponse = await fetch(`${apiBaseUrl}/api/recordings/${createData.recording.id}/audio`, {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error('Не удалось загрузить файл');
      }

      await loadRecordings();
      setStatus(`Запись "${file.name}" загружена`);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDelete(recording) {
    const confirmed = window.confirm(`Удалить запись "${recording.title}"?`);

    if (!confirmed) {
      return;
    }

    setDeletingId(recording.id);
    setStatus(`Удаляем "${recording.title}"...`);

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recording.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Не удалось удалить запись');
      }

      setRecordings((current) => current.filter((item) => item.id !== recording.id));
      setStatus(`Запись "${recording.title}" удалена`);
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">VoxMate</p>
          <h1 id="page-title">Записи</h1>
        </div>

        <div className="actions">
          <button className="button button-secondary" type="button" onClick={loadRecordings} disabled={isLoading || isUploading}>
            Обновить
          </button>

          <label className={`button button-primary ${isUploading ? 'is-disabled' : ''}`}>
            <input type="file" accept="audio/*,video/webm,.webm,.mp3,.wav,.m4a,.ogg" onChange={handleFileChange} disabled={isUploading} />
            {isUploading ? 'Загрузка...' : 'Загрузить запись'}
          </label>
        </div>
      </section>

      <section className="status-line" aria-live="polite">
        {status || (hasRecordings ? `${recordings.length} записей в библиотеке` : 'Записей пока нет')}
      </section>

      <section className="recording-list" aria-label="Список записей">
        {isLoading && !hasRecordings ? <div className="empty-state">Получаем список записей...</div> : null}

        {!isLoading && !hasRecordings ? (
          <div className="empty-state">
            <h2>Нет загруженных записей</h2>
            <p>Добавь первый аудиофайл через кнопку загрузки.</p>
          </div>
        ) : null}

        {sortedRecordings.map((recording) => (
          <article className="recording-row" key={recording.id}>
            <div className="recording-main">
              <div className="recording-title-row">
                <h2>{recording.title}</h2>
                <span className={`status-pill status-${recording.status}`}>{recording.status}</span>
              </div>

              <div className="recording-meta">
                <span>{recording.originalFilename || 'файл не прикреплен'}</span>
                <span>{formatFileSize(recording.fileSizeBytes)}</span>
                <span>{formatDate(recording.createdAt)}</span>
              </div>

              {recording.storageKey ? <code className="storage-key">{recording.storageKey}</code> : null}
            </div>

            <button
              className="button button-danger"
              type="button"
              onClick={() => handleDelete(recording)}
              disabled={deletingId === recording.id}
            >
              {deletingId === recording.id ? 'Удаляем...' : 'Удалить'}
            </button>
          </article>
        ))}
      </section>
    </main>
  );
}

export default App;
