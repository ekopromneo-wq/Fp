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
  const [projects, setProjects] = useState([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [status, setStatus] = useState('Загружаем записи...');
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [recordingDraft, setRecordingDraft] = useState({ title: '', projectId: '' });
  const [newProjectDraft, setNewProjectDraft] = useState({ name: '', color: '#235b4f' });
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState(null);
  const [deletingTaskId, setDeletingTaskId] = useState(null);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState({});
  const [speakerDrafts, setSpeakerDrafts] = useState({});
  const [savingSpeakerLabel, setSavingSpeakerLabel] = useState(null);
  const [newTaskDraft, setNewTaskDraft] = useState({ assignee: '', dueText: '', description: '' });
  const [processingId, setProcessingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const hasRecordings = recordings.length > 0;
  const sortedRecordings = useMemo(() => recordings, [recordings]);
  const canProcessSelected =
    selectedRecording &&
    selectedRecording.status !== 'queued' &&
    selectedRecording.status !== 'processing' &&
    processingId !== selectedRecording.id;

  const projectOptions = useMemo(() => projects, [projects]);

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
    setProjects([]);
    setSelectedRecordingId(null);
    setSelectedRecording(null);
    setStatus('');
  }

  async function loadProjects() {
    try {
      const response = await apiFetch('/api/projects');

      if (!response.ok) {
        throw new Error('Не удалось получить проекты');
      }

      const data = await response.json();
      setProjects(data.projects || []);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки проектов');
    }
  }

  async function loadRecordings(nextSelectedId = selectedRecordingId) {
    setIsLoading(true);

    try {
      const params = new URLSearchParams();

      if (searchQuery.trim()) {
        params.set('search', searchQuery.trim());
      }

      if (projectFilter) {
        params.set('projectId', projectFilter);
      }

      const response = await apiFetch(`/api/recordings${params.toString() ? `?${params.toString()}` : ''}`);

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
      loadProjects();
      loadRecordings();
    }
  }, [currentUser?.id, searchQuery, projectFilter]);

  useEffect(() => {
    if (currentUser) {
      loadRecordingDetail(selectedRecordingId);
    }
  }, [selectedRecordingId, currentUser?.id]);

  useEffect(() => {
    setRecordingDraft({
      title: selectedRecording?.title || '',
      projectId: selectedRecording?.projectId || '',
    });
  }, [selectedRecording?.id, selectedRecording?.title, selectedRecording?.projectId]);

  async function handleCreateProject(event) {
    event.preventDefault();

    if (!newProjectDraft.name.trim()) {
      setStatus('Заполни название проекта');
      return;
    }

    setIsCreatingProject(true);

    try {
      const response = await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify(newProjectDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось создать проект');
      }

      setProjects((current) => [...current, data.project].sort((a, b) => a.name.localeCompare(b.name)));
      setNewProjectDraft({ name: '', color: '#235b4f' });
      setStatus('Проект создан');
    } catch (error) {
      setStatus(error.message || 'Ошибка создания проекта');
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleSaveRecordingMetadata() {
    if (!selectedRecording) {
      return;
    }

    if (!recordingDraft.title.trim()) {
      setStatus('Заполни название записи');
      return;
    }

    setIsSavingRecording(true);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: recordingDraft.title,
          projectId: recordingDraft.projectId || null,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить запись');
      }

      setSelectedRecording((current) => (current?.id === data.recording.id ? { ...current, ...data.recording } : current));
      setRecordings((current) => current.map((recording) => (recording.id === data.recording.id ? { ...recording, ...data.recording } : recording)));
      setStatus('Запись сохранена');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения записи');
    } finally {
      setIsSavingRecording(false);
    }
  }

  async function handleGenerateTitle() {
    if (!selectedRecording) {
      return;
    }

    setIsGeneratingTitle(true);
    setStatus(`Готовим название для "${selectedRecording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/title-suggestion`, {
        method: 'POST',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось предложить название');
      }

      setSelectedRecording((current) => (current?.id === data.recording.id ? { ...current, ...data.recording } : current));
      setRecordings((current) => current.map((recording) => (recording.id === data.recording.id ? { ...recording, ...data.recording } : recording)));
      setRecordingDraft((current) => ({ ...current, title: data.recording.title }));
      setStatus('AI-название применено');
    } catch (error) {
      setStatus(error.message || 'Ошибка генерации названия');
    } finally {
      setIsGeneratingTitle(false);
    }
  }

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

  async function handleSummarize(recording) {
    if (!recording?.transcript) {
      setStatus('Сначала нужна стенограмма');
      return;
    }

    setIsSummarizing(true);
    setStatus(`Готовим протокол "${recording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/summary`, {
        method: 'POST',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сделать протокол');
      }

      setSelectedRecording((current) =>
        current?.id === recording.id ? { ...current, summary: data.summary, tasks: data.tasks || [] } : current,
      );
      setRecordings((current) =>
        current.map((item) => (item.id === recording.id ? { ...item, summary: data.summary, tasks: data.tasks || [] } : item)),
      );
      setStatus(`Протокол "${recording.title}" готов`);
    } catch (error) {
      setStatus(error.message || 'Ошибка создания протокола');
    } finally {
      setIsSummarizing(false);
    }
  }

  function getTaskDraft(task) {
    return (
      taskDrafts[task.id] || {
        assignee: task.assignee || '',
        dueText: task.dueText || '',
        description: task.description || '',
      }
    );
  }

  function updateTaskDraft(task, field, value) {
    setTaskDrafts((current) => ({
      ...current,
      [task.id]: {
        ...getTaskDraft(task),
        [field]: value,
      },
    }));
  }

  function applyTaskUpdate(task) {
    setSelectedRecording((current) => {
      if (!current?.tasks) {
        return current;
      }

      const tasks =
        task.status === 'dismissed'
          ? current.tasks.filter((item) => item.id !== task.id)
          : current.tasks.map((item) => (item.id === task.id ? task : item));

      return { ...current, tasks };
    });
  }

  function appendTask(task) {
    setSelectedRecording((current) =>
      current ? { ...current, tasks: [...(current.tasks || []), task] } : current,
    );
  }

  function removeTask(taskId) {
    setSelectedRecording((current) =>
      current?.tasks ? { ...current, tasks: current.tasks.filter((task) => task.id !== taskId) } : current,
    );
    setTaskDrafts((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function updateNewTaskDraft(field, value) {
    setNewTaskDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleAddTask(event) {
    event.preventDefault();

    if (!selectedRecording) {
      return;
    }

    if (!newTaskDraft.description.trim()) {
      setStatus('Заполни описание задачи');
      return;
    }

    setIsAddingTask(true);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify(newTaskDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось добавить задачу');
      }

      appendTask(data.task);
      setNewTaskDraft({ assignee: '', dueText: '', description: '' });
      setStatus('Задача добавлена');
    } catch (error) {
      setStatus(error.message || 'Ошибка добавления задачи');
    } finally {
      setIsAddingTask(false);
    }
  }

  async function updateTask(task, patch, successMessage) {
    if (!selectedRecording) {
      return;
    }

    setSavingTaskId(task.id);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось обновить задачу');
      }

      applyTaskUpdate(data.task);
      setTaskDrafts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message || 'Ошибка обновления задачи');
    } finally {
      setSavingTaskId(null);
    }
  }

  async function handleSaveTask(task) {
    const draft = getTaskDraft(task);

    await updateTask(
      task,
      {
        assignee: draft.assignee,
        dueText: draft.dueText,
        description: draft.description,
      },
      'Задача сохранена',
    );
  }

  async function handleConfirmTask(task) {
    await updateTask(task, { status: 'confirmed' }, 'Задача подтверждена');
  }

  async function handleDismissTask(task) {
    await updateTask(task, { status: 'dismissed' }, 'Задача скрыта');
  }

  async function handleDeleteTask(task) {
    if (!selectedRecording) {
      return;
    }

    const confirmed = window.confirm('Удалить задачу окончательно?');

    if (!confirmed) {
      return;
    }

    setDeletingTaskId(task.id);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось удалить задачу');
      }

      removeTask(task.id);
      setStatus('Задача удалена');
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления задачи');
    } finally {
      setDeletingTaskId(null);
    }
  }

  function getSpeakerDraft(speaker) {
    return (
      speakerDrafts[speaker.label] || {
        displayName: speaker.displayName || '',
        contactName: speaker.contactName || '',
        contactEmail: speaker.contactEmail || '',
      }
    );
  }

  function updateSpeakerDraft(speaker, field, value) {
    setSpeakerDrafts((current) => ({
      ...current,
      [speaker.label]: {
        ...getSpeakerDraft(speaker),
        [field]: value,
      },
    }));
  }

  function applySpeakerUpdate(speaker) {
    setSelectedRecording((current) => {
      if (!current?.speakers) {
        return current;
      }

      const speakers = current.speakers.map((item) => (item.label === speaker.label ? speaker : item));

      return { ...current, speakers };
    });
  }

  async function handleSaveSpeaker(speaker) {
    if (!selectedRecording) {
      return;
    }

    const draft = getSpeakerDraft(speaker);

    if (!draft.displayName.trim()) {
      setStatus('Заполни имя спикера');
      return;
    }

    setSavingSpeakerLabel(speaker.label);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/speakers/${encodeURIComponent(speaker.label)}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить спикера');
      }

      applySpeakerUpdate(data.speaker);
      setSpeakerDrafts((current) => {
        const next = { ...current };
        delete next[speaker.label];
        return next;
      });
      setStatus('Спикер сохранён');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения спикера');
    } finally {
      setSavingSpeakerLabel(null);
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

      <section className="library-controls" aria-label="Фильтры библиотеки">
        <label>
          Поиск
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Название, файл, проект или текст стенограммы"
          />
        </label>

        <label>
          Проект
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">Все проекты</option>
            {projectOptions.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <form className="project-create-form" onSubmit={handleCreateProject}>
          <input
            value={newProjectDraft.name}
            onChange={(event) => setNewProjectDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Новый проект"
          />
          <input
            className="project-color-input"
            value={newProjectDraft.color}
            onChange={(event) => setNewProjectDraft((current) => ({ ...current, color: event.target.value }))}
            type="color"
            aria-label="Цвет проекта"
          />
          <button className="button button-secondary" type="submit" disabled={isCreatingProject}>
            {isCreatingProject ? 'Создаём...' : 'Создать'}
          </button>
        </form>
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
                  {recording.project ? (
                    <span className="project-chip" style={{ '--project-color': recording.project.color }}>
                      {recording.project.name}
                    </span>
                  ) : null}
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
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => handleSummarize(selectedRecording)}
                  disabled={!selectedRecording.transcript || isSummarizing}
                >
                  {isSummarizing ? 'Готовим...' : 'Сделать протокол'}
                </button>
              </div>

              <section className="recording-edit-panel" aria-label="Редактирование записи">
                <label>
                  Название
                  <input
                    value={recordingDraft.title}
                    onChange={(event) => setRecordingDraft((current) => ({ ...current, title: event.target.value }))}
                  />
                </label>

                <label>
                  Проект
                  <select
                    value={recordingDraft.projectId}
                    onChange={(event) => setRecordingDraft((current) => ({ ...current, projectId: event.target.value }))}
                  >
                    <option value="">Без проекта</option>
                    {projectOptions.map((project) => (
                      <option value={project.id} key={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="recording-edit-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={handleGenerateTitle}
                    disabled={isGeneratingTitle || (!selectedRecording.transcript && !selectedRecording.summary)}
                  >
                    {isGeneratingTitle ? 'Думаем...' : 'AI-название'}
                  </button>
                  {selectedRecording.autoNamed ? <span className="auto-name-badge">AI</span> : null}
                </div>

                <button className="button button-secondary" type="button" onClick={handleSaveRecordingMetadata} disabled={isSavingRecording}>
                  {isSavingRecording ? 'Сохраняем...' : 'Сохранить запись'}
                </button>
              </section>

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
                <h3>Спикеры</h3>
                {selectedRecording.speakers?.length ? (
                  <div className="speaker-list">
                    {selectedRecording.speakers.map((speaker) => {
                      const draft = getSpeakerDraft(speaker);
                      const isSavingSpeaker = savingSpeakerLabel === speaker.label;

                      return (
                        <div className="speaker-row" key={speaker.label}>
                          <div className="speaker-row-header">
                            <strong>{speaker.label}</strong>
                            <span>{speaker.id ? 'Сохранён' : 'Из стенограммы'}</span>
                          </div>

                          <label>
                            Имя в протоколе
                            <input
                              value={draft.displayName}
                              onChange={(event) => updateSpeakerDraft(speaker, 'displayName', event.target.value)}
                              placeholder="Спикер"
                            />
                          </label>

                          <label>
                            Контакт
                            <input
                              value={draft.contactName}
                              onChange={(event) => updateSpeakerDraft(speaker, 'contactName', event.target.value)}
                              placeholder="Имя контакта"
                            />
                          </label>

                          <label>
                            Email
                            <input
                              value={draft.contactEmail}
                              onChange={(event) => updateSpeakerDraft(speaker, 'contactEmail', event.target.value)}
                              placeholder="name@example.com"
                            />
                          </label>

                          <button className="button button-secondary" type="button" onClick={() => handleSaveSpeaker(speaker)} disabled={isSavingSpeaker}>
                            {isSavingSpeaker ? 'Сохраняем...' : 'Сохранить спикера'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted-text">Спикеры появятся после стенограммы с сегментами ASR.</p>
                )}
              </section>

              <section className="detail-section">
                <h3>Резюме</h3>
                {selectedRecording.summary ? (
                  <div className="summary-block">
                    <p>{selectedRecording.summary.summary}</p>

                    {selectedRecording.summary.actionItems?.length ? (
                      <>
                        <h4>Action items</h4>
                        <ul>
                          {selectedRecording.summary.actionItems.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}

                    {selectedRecording.summary.topics?.length ? (
                      <div className="topic-list">
                        {selectedRecording.summary.topics.map((topic) => (
                          <span key={topic}>{topic}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="muted-text">Протокола пока нет. Сделай его после появления стенограммы.</p>
                )}
              </section>

              {selectedRecording.summary?.protocol ? (
                <section className="detail-section">
                  <h3>Протокол</h3>
                  <div className="protocol-grid">
                    <div>
                      <h4>Повестка</h4>
                      {selectedRecording.summary.protocol.agenda?.length ? (
                        <ul>
                          {selectedRecording.summary.protocol.agenda.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-text">Не выделена.</p>
                      )}
                    </div>

                    <div>
                      <h4>Решения</h4>
                      {selectedRecording.summary.protocol.decisions?.length ? (
                        <ul>
                          {selectedRecording.summary.protocol.decisions.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-text">Не выделены.</p>
                      )}
                    </div>

                    <div>
                      <h4>Риски</h4>
                      {selectedRecording.summary.protocol.risks?.length ? (
                        <ul>
                          {selectedRecording.summary.protocol.risks.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-text">Не выделены.</p>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="detail-section">
                <h3>Задачи</h3>
                <form className="task-row task-create-form" onSubmit={handleAddTask}>
                  <div className="task-row-header">
                    <strong>Новая задача</strong>
                  </div>

                  <label>
                    Исполнитель
                    <input
                      value={newTaskDraft.assignee}
                      onChange={(event) => updateNewTaskDraft('assignee', event.target.value)}
                      placeholder="Не указан"
                    />
                  </label>

                  <label>
                    Срок
                    <input
                      value={newTaskDraft.dueText}
                      onChange={(event) => updateNewTaskDraft('dueText', event.target.value)}
                      placeholder="Не указан"
                    />
                  </label>

                  <label>
                    Что сделать
                    <textarea
                      value={newTaskDraft.description}
                      onChange={(event) => updateNewTaskDraft('description', event.target.value)}
                      rows={3}
                      placeholder="Описание задачи"
                    />
                  </label>

                  <button className="button button-primary" type="submit" disabled={isAddingTask}>
                    {isAddingTask ? 'Добавляем...' : 'Добавить задачу'}
                  </button>
                </form>

                {selectedRecording.tasks?.length ? (
                  <div className="task-list">
                    {selectedRecording.tasks.map((task) => {
                      const draft = getTaskDraft(task);
                      const isSavingTask = savingTaskId === task.id;
                      const isDeletingTask = deletingTaskId === task.id;

                      return (
                        <div className={`task-row task-status-${task.status}`} key={task.id}>
                          <div className="task-row-header">
                            <strong>{task.status === 'confirmed' ? 'Подтверждена' : 'Извлечена'}</strong>
                            <span>{formatDate(task.updatedAt)}</span>
                          </div>

                          <label>
                            Исполнитель
                            <input
                              value={draft.assignee}
                              onChange={(event) => updateTaskDraft(task, 'assignee', event.target.value)}
                              placeholder="Не указан"
                            />
                          </label>

                          <label>
                            Срок
                            <input
                              value={draft.dueText}
                              onChange={(event) => updateTaskDraft(task, 'dueText', event.target.value)}
                              placeholder="Не указан"
                            />
                          </label>

                          <label>
                            Что сделать
                            <textarea
                              value={draft.description}
                              onChange={(event) => updateTaskDraft(task, 'description', event.target.value)}
                              rows={3}
                            />
                          </label>

                          <div className="task-actions">
                            <button className="button button-secondary" type="button" onClick={() => handleSaveTask(task)} disabled={isSavingTask}>
                              {isSavingTask ? 'Сохраняем...' : 'Сохранить'}
                            </button>
                            <button
                              className="button button-primary"
                              type="button"
                              onClick={() => handleConfirmTask(task)}
                              disabled={isSavingTask || task.status === 'confirmed'}
                            >
                              Подтвердить
                            </button>
                            <button className="button button-danger" type="button" onClick={() => handleDismissTask(task)} disabled={isSavingTask}>
                              Скрыть
                            </button>
                            <button
                              className="button button-danger"
                              type="button"
                              onClick={() => handleDeleteTask(task)}
                              disabled={isSavingTask || isDeletingTask}
                            >
                              {isDeletingTask ? 'Удаляем...' : 'Удалить'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted-text">Задач пока нет. Они появятся после генерации протокола, если модель найдёт поручения.</p>
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
