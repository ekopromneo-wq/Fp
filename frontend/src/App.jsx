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
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getAudioUrl(recording) {
  return recording?.storageKey ? `${apiBaseUrl}/api/recordings/${recording.id}/audio` : '';
}

function App() {
  const [recordings, setRecordings] = useState([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [status, setStatus] = useState('Загружаем записи...');
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [processingId, setProcessingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const hasRecordings = recordings.length > 0;
  const sortedRecordings = useMemo(() => recordings, [recordings]);
  const canProcessSelected =
    selectedRecording &&
    selectedRecording.status !== 'queued' &&
    selectedRecording.status !== 'processing' &&
    processingId !== selectedRecording.id;

  async function loadRecordings(nextSelectedId = selectedRecordingId) {
    setIsLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings`);

      if (!response.ok) {
        throw new Error('Не удалось получить список записей');
      }

      const data = await response.json();
      const nextRecordings = data.recordings || [];
      setRecordings(nextRecordings);

      const fallbackId = nextRecordings[0]?.id || null;
      const existingId = nextRecordings.some((recording) => recording.id === nextSelectedId) ? nextSelectedId : fallbackId;
      setSelectedRecordingId(existingId);
      setStatus('');

      return nextRecordings;
    } catch (error) {
      setStatus(error.message || 'Backend недоступен');
      return [];
    } finally {
      setIsLoading(false);
    }
  }

  async function loadRecordingDetail(recordingId) {
    if (!recordingId) {
      setSelectedRecording(null);
      return;
    }

    setIsDetailLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}`);

      if (!response.ok) {
        throw new Error('Не удалось получить запись');
      }

      const data = await response.json();
      setSelectedRecording(data.recording);
    } catch (error) {
      setStatus(error.message || 'Не удалось открыть запись');
      setSelectedRecording(null);
    } finally {
      setIsDetailLoading(false);
    }
  }

  useEffect(() => {
    loadRecordings();
  }, []);

  useEffect(() => {
    loadRecordingDetail(selectedRecordingId);
  }, [selectedRecordingId]);

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

      await loadRecordings(createData.recording.id);
      setStatus(`Запись "${file.name}" загружена`);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleProcess(recording) {
    if (!recording) {
      return;
    }

    setProcessingId(recording.id);
    setStatus(`Запускаем обработку "${recording.title}"...`);

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recording.id}/jobs`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Не удалось запустить обработку');
      }

      await loadRecordings(recording.id);
      await loadRecordingDetail(recording.id);
      setStatus(`Обработка "${recording.title}" поставлена в очередь`);
    } catch (error) {
      setStatus(error.message || 'Ошибка запуска обработки');
    } finally {
      setProcessingId(null);
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

      const nextSelectedId = selectedRecordingId === recording.id ? null : selectedRecordingId;
      setSelectedRecordingId(nextSelectedId);
      setSelectedRecording((current) => (current?.id === recording.id ? null : current));
      await loadRecordings(nextSelectedId);
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
          <button className="button button-secondary" type="button" onClick={() => loadRecordings()} disabled={isLoading || isUploading}>
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

      <section className="workspace" aria-label="Рабочая область записей">
        <section className="recording-list" aria-label="Список записей">
          {isLoading && !hasRecordings ? <div className="empty-state">Получаем список записей...</div> : null}

          {!isLoading && !hasRecordings ? (
            <div className="empty-state">
              <h2>Нет загруженных записей</h2>
              <p>Добавь первый аудиофайл через кнопку загрузки.</p>
            </div>
          ) : null}

          {sortedRecordings.map((recording) => (
            <article
              className={`recording-row ${selectedRecordingId === recording.id ? 'is-selected' : ''}`}
              key={recording.id}
              onClick={() => setSelectedRecordingId(recording.id)}
            >
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
                onClick={(event) => {
                  event.stopPropagation();
                  handleDelete(recording);
                }}
                disabled={deletingId === recording.id}
              >
                {deletingId === recording.id ? 'Удаляем...' : 'Удалить'}
              </button>
            </article>
          ))}
        </section>

        <aside className="detail-panel" aria-label="Детали записи">
          {!selectedRecordingId ? (
            <div className="empty-state detail-empty">Выбери запись, чтобы увидеть детали.</div>
          ) : null}

          {selectedRecordingId && isDetailLoading ? <div className="empty-state detail-empty">Открываем запись...</div> : null}

          {selectedRecording && !isDetailLoading ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">Детали</p>
                  <h2>{selectedRecording.title}</h2>
                </div>
                <span className={`status-pill status-${selectedRecording.status}`}>{selectedRecording.status}</span>
              </div>

              <div className="detail-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => handleProcess(selectedRecording)}
                  disabled={!canProcessSelected}
                >
                  {processingId === selectedRecording.id ? 'Запускаем...' : 'Запустить обработку'}
                </button>
              </div>

              <dl className="detail-grid">
                <div>
                  <dt>Файл</dt>
                  <dd>{selectedRecording.originalFilename || 'не прикреплен'}</dd>
                </div>
                <div>
                  <dt>Размер</dt>
                  <dd>{formatFileSize(selectedRecording.fileSizeBytes)}</dd>
                </div>
                <div>
                  <dt>Источник</dt>
                  <dd>{selectedRecording.source}</dd>
                </div>
                <div>
                  <dt>Создана</dt>
                  <dd>{formatDate(selectedRecording.createdAt)}</dd>
                </div>
              </dl>

              {selectedRecording.storageKey ? (
                <section className="detail-section">
                  <h3>Аудио</h3>
                  <audio controls preload="metadata" src={getAudioUrl(selectedRecording)} />
                </section>
              ) : (
                <section className="detail-section muted-section">
                  <h3>Аудио</h3>
                  <p>К этой записи пока не прикреплен файл.</p>
                </section>
              )}

              <section className="detail-section">
                <h3>Стенограмма</h3>
                {selectedRecording.transcript ? (
                  <p className="transcript-text">{selectedRecording.transcript.text}</p>
                ) : (
                  <p className="muted-text">Стенограммы пока нет. Запусти обработку записи.</p>
                )}
              </section>

              <section className="detail-section">
                <h3>Jobs</h3>
                {selectedRecording.jobs?.length ? (
                  <div className="job-list">
                    {selectedRecording.jobs.map((job) => (
                      <div className="job-row" key={job.id}>
                        <div>
                          <strong>{job.status}</strong>
                          <span>{formatDate(job.createdAt)}</span>
                        </div>
                        {job.error ? <p>{job.error}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted-text">Обработки ещё не запускались.</p>
                )}
              </section>
            </>
          ) : null}
        </aside>
      </section>
    </main>
  );
}

export default App;
