import { useEffect, useMemo, useState } from 'react';
import './App.css';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const demoEmail = import.meta.env.VITE_DEMO_EMAIL || 'demo@voxmate.local';
const demoPassword = import.meta.env.VITE_DEMO_PASSWORD || 'voxmate123';

function apiFetch(path, options = {}) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
}

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

function isProcessingStatus(status) {
  return status === 'queued' || status === 'processing';
}

function AuthScreen({ authMode, setAuthMode, onSubmit, isSubmitting, authMessage }) {
  const [email, setEmail] = useState(demoEmail);
  const [password, setPassword] = useState(demoPassword);
  const [displayName, setDisplayName] = useState('Demo User');
  const isRegister = authMode === 'register';

  function handleSubmit(event) {
    event.preventDefault();
    onSubmit({
      email,
      password,
      displayName,
    });
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <p className="eyebrow">VoxMate</p>
        <h1 id="auth-title">{isRegister ? 'Создать аккаунт' : 'Вход'}</h1>
        <p className="auth-copy">Рабочая область записей доступна после входа.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister ? (
            <label>
              Имя
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}

          <label>
            Email
            <input value={email} type="email" onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>

          <label>
            Пароль
            <input
              value={password}
              type="password"
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </label>

          <button className="button button-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Проверяем...' : isRegister ? 'Зарегистрироваться' : 'Войти'}
          </button>
        </form>

        <button className="link-button" type="button" onClick={() => setAuthMode(isRegister ? 'login' : 'register')}>
          {isRegister ? 'Уже есть аккаунт' : 'Создать новый аккаунт'}
        </button>

        {authMessage ? <p className="auth-message">{authMessage}</p> : null}
      </section>
    </main>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState('login');
  const [authMessage, setAuthMessage] = useState('');
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
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

  async function loadCurrentUser() {
    setIsAuthLoading(true);

    try {
      const response = await apiFetch('/api/auth/me');
      const data = await response.json();
      setCurrentUser(data.user || null);
    } catch {
      setCurrentUser(null);
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function handleAuthSubmit(input) {
    setIsAuthSubmitting(true);
    setAuthMessage('');

    try {
      const response = await apiFetch(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось войти');
      }

      setCurrentUser(data.user);
      setAuthMessage('');
    } catch (error) {
      setAuthMessage(error.message || 'Ошибка авторизации');
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', {
      method: 'POST',
    }).catch(() => null);

    setCurrentUser(null);
    setRecordings([]);
    setSelectedRecordingId(null);
    setSelectedRecording(null);
    setStatus('');
  }

  async function loadRecordings(nextSelectedId = selectedRecordingId) {
    setIsLoading(true);

    try {
      const response = await apiFetch('/api/recordings');

      if (response.status === 401) {
        setCurrentUser(null);
        throw new Error('Нужно войти заново');
      }

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

  async function loadRecordingDetail(recordingId, options = {}) {
    if (!recordingId) {
      setSelectedRecording(null);
      return;
    }

    if (!options.quiet) {
      setIsDetailLoading(true);
    }

    try {
      const response = await apiFetch(`/api/recordings/${recordingId}`);

      if (response.status === 401) {
        setCurrentUser(null);
        throw new Error('Нужно войти заново');
      }

      if (!response.ok) {
        throw new Error('Не удалось получить запись');
      }

      const data = await response.json();
      setSelectedRecording(data.recording);
      setRecordings((current) =>
        current.map((recording) => (recording.id === data.recording.id ? { ...recording, ...data.recording } : recording)),
      );
    } catch (error) {
      setStatus(error.message || 'Не удалось открыть запись');
      setSelectedRecording(null);
    } finally {
      if (!options.quiet) {
        setIsDetailLoading(false);
      }
    }
  }

  useEffect(() => {
    loadCurrentUser();
  }, []);

  useEffect(() => {
    if (currentUser) {
      loadRecordings();
    }
  }, [currentUser?.id]);

  useEffect(() => {
    if (currentUser) {
      loadRecordingDetail(selectedRecordingId);
    }
  }, [selectedRecordingId, currentUser?.id]);

  useEffect(() => {
    if (!currentUser || !selectedRecordingId || !isProcessingStatus(selectedRecording?.status)) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      loadRecordingDetail(selectedRecordingId, { quiet: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [currentUser?.id, selectedRecordingId, selectedRecording?.status]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setIsUploading(true);
    setStatus(`Загружаем ${file.name}...`);

    try {
      const createResponse = await apiFetch('/api/recordings', {
        method: 'POST',
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

      const uploadResponse = await apiFetch(`/api/recordings/${createData.recording.id}/audio`, {
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
      const response = await apiFetch(`/api/recordings/${recording.id}/jobs`, {
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
      const response = await apiFetch(`/api/recordings/${recording.id}`, {
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

  if (isAuthLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <p className="eyebrow">VoxMate</p>
          <h1>Проверяем вход</h1>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <AuthScreen
        authMode={authMode}
        setAuthMode={setAuthMode}
        onSubmit={handleAuthSubmit}
        isSubmitting={isAuthSubmitting}
        authMessage={authMessage}
      />
    );
  }

  return (
    <main className="app-shell">
      <section className="topbar" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">VoxMate</p>
          <h1 id="page-title">Записи</h1>
        </div>

        <div className="topbar-right">
          <div className="user-chip">
            <strong>{currentUser.displayName}</strong>
            <span>{currentUser.email}</span>
          </div>

          <div className="actions">
            <button className="button button-secondary" type="button" onClick={() => loadRecordings()} disabled={isLoading || isUploading}>
              Обновить
            </button>

            <label className={`button button-primary ${isUploading ? 'is-disabled' : ''}`}>
              <input type="file" accept="audio/*,video/webm,.webm,.mp3,.wav,.m4a,.ogg" onChange={handleFileChange} disabled={isUploading} />
              {isUploading ? 'Загрузка...' : 'Загрузить запись'}
            </label>

            <button className="button button-secondary" type="button" onClick={handleLogout}>
              Выйти
            </button>
          </div>
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
