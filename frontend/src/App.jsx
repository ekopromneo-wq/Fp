import { useEffect, useMemo, useState } from 'react';
import './App.css';
import Topbar from './components/Topbar.jsx';
import DiarizationSettingsPanel from './components/settings/DiarizationSettingsPanel.jsx';
import SmtpSettingsPanel from './components/settings/SmtpSettingsPanel.jsx';
import TelegramSettingsPanel from './components/settings/TelegramSettingsPanel.jsx';
import BitrixSettingsPanel from './components/settings/BitrixSettingsPanel.jsx';
import MicrophoneSettingsPanel from './components/settings/MicrophoneSettingsPanel.jsx';
import JobsList from './components/JobsList.jsx';
import SpeakerRow from './components/SpeakerRow.jsx';
import TaskForm from './components/TaskForm.jsx';
import TaskRow from './components/TaskRow.jsx';
import RecordingCard from './components/RecordingCard.jsx';
import useMicRecorder from './hooks/useMicRecorder.js';
import useIsMobile from './hooks/useIsMobile.js';
import useUiStore from './store/uiStore.js';
import VoicePanel from './components/VoicePanel/VoicePanel.jsx';
import { formatDate, formatFileSize } from './lib/format.js';

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

function getAudioUrl(recording) {
  return recording?.storageKey ? `${apiBaseUrl}/api/recordings/${recording.id}/audio` : '';
}

function escapeTableCell(value) {
  return String(value || '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatMarkdownList(items) {
  return items?.length ? items.map((item) => `- ${item}`).join('\n') : '- не выделено';
}

function buildRecordingExport(recording) {
  const summary = recording.summary;
  const protocol = summary?.protocol;
  const tasks = recording.tasks || [];
  const speakers = recording.speakers || [];
  const lines = [
    `# ${recording.title}`,
    '',
    `Файл: ${recording.originalFilename || 'не прикреплен'}`,
    `Дата загрузки: ${formatDate(recording.createdAt)}`,
    `Статус: ${recording.status}`,
    `Проект: ${recording.project?.name || 'без проекта'}`,
    '',
  ];

  lines.push('## Резюме', '', summary?.summary || 'Резюме пока нет.', '');

  lines.push('## Протокол', '');
  if (protocol) {
    lines.push('### Повестка', formatMarkdownList(protocol.agenda), '');
    lines.push('### Решения', formatMarkdownList(protocol.decisions), '');
    lines.push('### Риски', formatMarkdownList(protocol.risks), '');
  } else {
    lines.push('Протокол пока не создан.', '');
  }

  lines.push('## Задачи', '');
  if (tasks.length) {
    lines.push('| Исполнитель | Срок | Статус | Описание |');
    lines.push('| --- | --- | --- | --- |');
    tasks.forEach((task) => {
      lines.push(
        `| ${escapeTableCell(task.assignee)} | ${escapeTableCell(task.dueText)} | ${escapeTableCell(task.status)} | ${escapeTableCell(task.description)} |`,
      );
    });
    lines.push('');
  } else {
    lines.push('Задач пока нет.', '');
  }

  lines.push('## Спикеры', '');
  if (speakers.length) {
    speakers.forEach((speaker) => {
      const displayName = speaker.displayName || speaker.label;
      const contact = [speaker.contactName, speaker.contactEmail].filter(Boolean).join(', ');
      lines.push(`- ${displayName}${contact ? ` (${contact})` : ''}`);
    });
    lines.push('');
  } else {
    lines.push('Спикеры пока не выделены.', '');
  }

  lines.push('## Стенограмма', '', recording.transcript?.text || 'Стенограммы пока нет.', '');

  return lines.join('\n');
}

function createExportFilename(recording) {
  const baseName = (recording.title || recording.originalFilename || 'recording')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${baseName || 'recording'}-protocol.md`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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
  const [activePage, setActivePage] = useState('library');
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [status, setStatus] = useState('Загружаем записи...');
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [recordingDraft, setRecordingDraft] = useState({ title: '', projectId: '' });
  const [newProjectDraft, setNewProjectDraft] = useState({ name: '', color: '#235b4f' });
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [meetingBotDraft, setMeetingBotDraft] = useState({ meetingUrl: '', title: '' });
  const [isJoiningMeeting, setIsJoiningMeeting] = useState(false);
  const [isStoppingMeetingBot, setIsStoppingMeetingBot] = useState(false);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryLength, setSummaryLength] = useState('medium');
  const [savingTaskId, setSavingTaskId] = useState(null);
  const [deletingTaskId, setDeletingTaskId] = useState(null);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState({});
  const [speakerDrafts, setSpeakerDrafts] = useState({});
  const [speakerMatches, setSpeakerMatches] = useState({});
  const [isLoadingSpeakerMatches, setIsLoadingSpeakerMatches] = useState(false);
  const [savingSpeakerLabel, setSavingSpeakerLabel] = useState(null);
  const [newTaskDraft, setNewTaskDraft] = useState({ assignee: '', dueText: '', description: '' });
  const [emailDraft, setEmailDraft] = useState({ recipients: '', message: '' });
  const [smtpDraft, setSmtpDraft] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '' });
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [telegramSettingsDraft, setTelegramSettingsDraft] = useState({ chatId: '', botToken: '' });
  const [telegramHasToken, setTelegramHasToken] = useState(false);
  const [isSavingTelegramSettings, setIsSavingTelegramSettings] = useState(false);
  const [bitrixSettingsDraft, setBitrixSettingsDraft] = useState({ webhookUrl: '', defaultResponsibleId: '', defaultGroupId: '' });
  const [bitrixHasWebhook, setBitrixHasWebhook] = useState(false);
  const [isSavingBitrixSettings, setIsSavingBitrixSettings] = useState(false);
  const [diarizationSettingsDraft, setDiarizationSettingsDraft] = useState({
    method: 'shopot',
    shopotApiKey: '',
    geminiModel: 'google/gemini-2.5-pro',
    speech2textApiKey: '',
    kimiModel: 'moonshotai/kimi-k2.6',
  });
  const [diarizationHasShopotKey, setDiarizationHasShopotKey] = useState(false);
  const [diarizationHasSpeech2textKey, setDiarizationHasSpeech2textKey] = useState(false);
  const [isSavingDiarizationSettings, setIsSavingDiarizationSettings] = useState(false);
  const [telegramDraft, setTelegramDraft] = useState({ chatId: '', message: '' });
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isSendingBitrixTaskId, setIsSendingBitrixTaskId] = useState(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [processingId, setProcessingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [isJobsCollapsed, setIsJobsCollapsed] = useState(false);

  const micDeviceId = useUiStore((state) => state.micDeviceId);
  const setMicDeviceId = useUiStore((state) => state.setMicDeviceId);

  const {
    isMicRecording,
    isMicPaused,
    canPauseMicRecording,
    micLevel,
    micDuration,
    isMicLevelLow,
    analyserRef: micAnalyserRef,
    handleMicRecordingToggle,
    handleMicPauseToggle,
  } = useMicRecorder(uploadRecordingFile, setStatus, micDeviceId);
  const isMobile = useIsMobile();
  const isVoicePanelOpen = useUiStore((state) => state.isVoicePanelOpen);
  const openVoicePanel = useUiStore((state) => state.openVoicePanel);
  const closeVoicePanel = useUiStore((state) => state.closeVoicePanel);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const handleMicButtonClick = isMobile ? openVoicePanel : handleMicRecordingToggle;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const hasRecordings = recordings.length > 0;
  const sortedRecordings = useMemo(() => recordings, [recordings]);
  const canProcessSelected =
    selectedRecording &&
    selectedRecording.status !== 'queued' &&
    selectedRecording.status !== 'processing' &&
    processingId !== selectedRecording.id;
  const canExportSelected =
    selectedRecording &&
    (selectedRecording.summary || selectedRecording.transcript || selectedRecording.tasks?.length || selectedRecording.speakers?.length);

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
    setActivePage('library');
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

  async function loadSmtpSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/smtp');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки SMTP');
      }

      setSmtpDraft({
        host: data.smtp?.host || '',
        port: String(data.smtp?.port || 587),
        secure: Boolean(data.smtp?.secure),
        user: data.smtp?.user || '',
        pass: '',
        from: data.smtp?.from || '',
      });
      setSmtpHasPassword(Boolean(data.smtp?.hasPassword));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек SMTP');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveSmtpSettings(event) {
    event.preventDefault();
    setIsSavingSettings(true);
    setStatus('Сохраняем SMTP-настройки...');

    try {
      const response = await apiFetch('/api/settings/smtp', {
        method: 'PATCH',
        body: JSON.stringify({
          ...smtpDraft,
          port: Number(smtpDraft.port || 587),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить SMTP-настройки');
      }

      setSmtpDraft((current) => ({ ...current, pass: '' }));
      setSmtpHasPassword(Boolean(data.smtp?.hasPassword));
      setStatus('SMTP-настройки сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения SMTP-настроек');
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function loadTelegramSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/telegram');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки Telegram');
      }

      setTelegramSettingsDraft({ chatId: data.telegram?.chatId || '', botToken: '' });
      setTelegramHasToken(Boolean(data.telegram?.hasToken));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек Telegram');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveTelegramSettings(event) {
    event.preventDefault();
    setIsSavingTelegramSettings(true);
    setStatus('Сохраняем настройки Telegram...');

    try {
      const response = await apiFetch('/api/settings/telegram', {
        method: 'PATCH',
        body: JSON.stringify(telegramSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки Telegram');
      }

      setTelegramSettingsDraft((current) => ({ ...current, botToken: '' }));
      setTelegramHasToken(Boolean(data.telegram?.hasToken));
      setStatus('Настройки Telegram сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек Telegram');
    } finally {
      setIsSavingTelegramSettings(false);
    }
  }

  async function loadBitrixSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/bitrix');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки Битрикс24');
      }

      setBitrixSettingsDraft({
        webhookUrl: '',
        defaultResponsibleId: data.bitrix?.defaultResponsibleId || '',
        defaultGroupId: data.bitrix?.defaultGroupId || '',
      });
      setBitrixHasWebhook(Boolean(data.bitrix?.hasWebhook));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек Битрикс24');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveBitrixSettings(event) {
    event.preventDefault();
    setIsSavingBitrixSettings(true);
    setStatus('Сохраняем настройки Битрикс24...');

    try {
      const response = await apiFetch('/api/settings/bitrix', {
        method: 'PATCH',
        body: JSON.stringify(bitrixSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки Битрикс24');
      }

      setBitrixSettingsDraft((current) => ({ ...current, webhookUrl: '' }));
      setBitrixHasWebhook(Boolean(data.bitrix?.hasWebhook));
      setStatus('Настройки Битрикс24 сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек Битрикс24');
    } finally {
      setIsSavingBitrixSettings(false);
    }
  }

  async function loadDiarizationSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/diarization');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки диаризации');
      }

      setDiarizationSettingsDraft({
        method: data.diarization?.method || 'shopot',
        shopotApiKey: '',
        geminiModel: data.diarization?.geminiModel || 'google/gemini-2.5-pro',
        speech2textApiKey: '',
        kimiModel: data.diarization?.kimiModel || 'moonshotai/kimi-k2.6',
      });
      setDiarizationHasShopotKey(Boolean(data.diarization?.hasShopotKey));
      setDiarizationHasSpeech2textKey(Boolean(data.diarization?.hasSpeech2textKey));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек диаризации');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveDiarizationSettings(event) {
    event.preventDefault();
    setIsSavingDiarizationSettings(true);
    setStatus('Сохраняем настройки диаризации...');

    try {
      const response = await apiFetch('/api/settings/diarization', {
        method: 'PATCH',
        body: JSON.stringify(diarizationSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки диаризации');
      }

      setDiarizationSettingsDraft((current) => ({ ...current, shopotApiKey: '', speech2textApiKey: '' }));
      setDiarizationHasShopotKey(Boolean(data.diarization?.hasShopotKey));
      setDiarizationHasSpeech2textKey(Boolean(data.diarization?.hasSpeech2textKey));
      setStatus('Настройки диаризации сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек диаризации');
    } finally {
      setIsSavingDiarizationSettings(false);
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
    if (currentUser && activePage === 'settings') {
      loadSmtpSettings();
      loadTelegramSettings();
      loadBitrixSettings();
      loadDiarizationSettings();
    }
  }, [currentUser?.id, activePage]);

  useEffect(() => {
    setRecordingDraft({
      title: selectedRecording?.title || '',
      projectId: selectedRecording?.projectId || '',
    });
  }, [selectedRecording?.id, selectedRecording?.title, selectedRecording?.projectId]);

  useEffect(() => {
    const recipients = [
      ...new Set((selectedRecording?.speakers || []).map((speaker) => speaker.contactEmail).filter(Boolean)),
    ].join(', ');

    setEmailDraft({ recipients, message: '' });
  }, [selectedRecording?.id]);

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

  async function handleJoinMeeting(event) {
    event.preventDefault();

    if (!meetingBotDraft.meetingUrl.trim()) {
      setStatus('Укажи ссылку на встречу');
      return;
    }

    setIsJoiningMeeting(true);
    setStatus('Отправляем бота на встречу...');

    try {
      const response = await apiFetch('/api/recordings/meeting-bot', {
        method: 'POST',
        body: JSON.stringify(meetingBotDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить бота на встречу');
      }

      setMeetingBotDraft({ meetingUrl: '', title: '' });
      await loadRecordings(data.recording.id);
      setStatus(`Бот отправлен на встречу "${data.recording.title}"`);
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки бота на встречу');
    } finally {
      setIsJoiningMeeting(false);
    }
  }

  async function handleStopMeetingBot(recording) {
    setIsStoppingMeetingBot(true);
    setStatus('Останавливаем бота...');

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/meeting-bot/stop`, {
        method: 'POST',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось остановить бота');
      }

      await loadRecordings(recording.id);
      setStatus('Бот остановлен');
    } catch (error) {
      setStatus(error.message || 'Ошибка остановки бота');
    } finally {
      setIsStoppingMeetingBot(false);
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

  async function uploadRecordingFile(file, source = 'frontend-upload') {
    setIsUploading(true);
    setStatus(`Загружаем ${file.name}...`);

    try {
      const createResponse = await apiFetch('/api/recordings', {
        method: 'POST',
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, '') || file.name,
          source,
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

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    await uploadRecordingFile(file);
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
        body: JSON.stringify({ length: summaryLength }),
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

  async function handleCopyExport(recording) {
    if (!recording) {
      return;
    }

    try {
      await copyText(buildRecordingExport(recording));
      setStatus(`Экспорт "${recording.title}" скопирован`);
    } catch {
      setStatus('Не удалось скопировать экспорт');
    }
  }

  function handleDownloadExport(recording) {
    if (!recording) {
      return;
    }

    downloadTextFile(createExportFilename(recording), buildRecordingExport(recording));
    setStatus(`Экспорт "${recording.title}" скачан`);
  }

  async function handleSendEmail(event) {
    event.preventDefault();

    if (!selectedRecording) {
      return;
    }

    if (!emailDraft.recipients.trim()) {
      setStatus('Укажи хотя бы одного получателя');
      return;
    }

    setIsSendingEmail(true);
    setStatus(`Отправляем протокол "${selectedRecording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/email`, {
        method: 'POST',
        body: JSON.stringify(emailDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить письмо');
      }

      setStatus(`Протокол "${selectedRecording.title}" отправлен`);
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки письма');
    } finally {
      setIsSendingEmail(false);
    }
  }

  async function handleSendTelegram(event) {
    event.preventDefault();

    if (!selectedRecording) {
      return;
    }

    setIsSendingTelegram(true);
    setStatus(`Отправляем "${selectedRecording.title}" в Telegram...`);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/telegram`, {
        method: 'POST',
        body: JSON.stringify(telegramDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить в Telegram');
      }

      setStatus(`Протокол "${selectedRecording.title}" отправлен в Telegram`);
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки в Telegram');
    } finally {
      setIsSendingTelegram(false);
    }
  }

  async function handleSendTaskToBitrix(task) {
    if (!selectedRecording) {
      return;
    }

    setIsSendingBitrixTaskId(task.id);
    setStatus(`Отправляем задачу в Битрикс24...`);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/bitrix`, {
        method: 'POST',
        body: JSON.stringify({ taskIds: [task.id] }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить задачу в Битрикс24');
      }

      const result = data.results?.[0];

      if (result && !result.ok) {
        throw new Error(result.error || 'Битрикс24 отклонил задачу');
      }

      await loadRecordingDetail(selectedRecording.id, { quiet: true });
      setStatus('Задача отправлена в Битрикс24');
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки в Битрикс24');
    } finally {
      setIsSendingBitrixTaskId(null);
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

  function applySpeakerCandidate(speaker, candidate) {
    setSpeakerDrafts((current) => ({
      ...current,
      [speaker.label]: {
        ...getSpeakerDraft(speaker),
        contactName: candidate.name,
        contactEmail: candidate.email,
      },
    }));
  }

  async function handleMatchSpeakersToBitrix() {
    if (!selectedRecording) {
      return;
    }

    setIsLoadingSpeakerMatches(true);
    setStatus('Ищем совпадения спикеров в Битрикс24...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/bitrix-speaker-matches`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сопоставить спикеров с Битрикс24');
      }

      const matchesByLabel = Object.fromEntries((data.matches || []).map((match) => [match.label, match]));
      setSpeakerMatches(matchesByLabel);

      for (const speaker of selectedRecording.speakers || []) {
        const match = matchesByLabel[speaker.label];
        const draft = getSpeakerDraft(speaker);

        if (match?.autoMatch && !draft.contactEmail) {
          applySpeakerCandidate(speaker, match.autoMatch);
        }
      }

      setStatus('Спикеры сопоставлены с Битрикс24');
    } catch (error) {
      setStatus(error.message || 'Ошибка сопоставления спикеров с Битрикс24');
    } finally {
      setIsLoadingSpeakerMatches(false);
    }
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
      <Topbar
        activePage={activePage}
        setActivePage={setActivePage}
        currentUser={currentUser}
        isUploading={isUploading}
        isMicRecording={isMicRecording}
        isMicPaused={isMicPaused}
        canPauseMicRecording={canPauseMicRecording}
        micLevel={micLevel}
        micDuration={micDuration}
        isMicLevelLow={isMicLevelLow}
        handleFileChange={handleFileChange}
        handleMicPauseToggle={handleMicPauseToggle}
        handleMicRecordingToggle={handleMicButtonClick}
        loadRecordings={loadRecordings}
        isLoading={isLoading}
        handleLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <VoicePanel
        isOpen={isVoicePanelOpen}
        onClose={closeVoicePanel}
        isMicRecording={isMicRecording}
        isMicPaused={isMicPaused}
        canPauseMicRecording={canPauseMicRecording}
        micDuration={micDuration}
        isMicLevelLow={isMicLevelLow}
        analyserRef={micAnalyserRef}
        onToggleRecording={handleMicRecordingToggle}
        onTogglePause={handleMicPauseToggle}
        status={status}
      />

      {activePage === 'settings' ? (
        <section className="settings-page" aria-label="Настройки SMTP">
          <MicrophoneSettingsPanel micDeviceId={micDeviceId} setMicDeviceId={setMicDeviceId} />

          <DiarizationSettingsPanel
            draft={diarizationSettingsDraft}
            setDraft={setDiarizationSettingsDraft}
            onSubmit={handleSaveDiarizationSettings}
            isSaving={isSavingDiarizationSettings}
            isSettingsLoading={isSettingsLoading}
            hasShopotKey={diarizationHasShopotKey}
            hasSpeech2textKey={diarizationHasSpeech2textKey}
          />

          <SmtpSettingsPanel
            draft={smtpDraft}
            setDraft={setSmtpDraft}
            onSubmit={handleSaveSmtpSettings}
            isSaving={isSavingSettings}
            isSettingsLoading={isSettingsLoading}
            hasPassword={smtpHasPassword}
          />

          <TelegramSettingsPanel
            draft={telegramSettingsDraft}
            setDraft={setTelegramSettingsDraft}
            onSubmit={handleSaveTelegramSettings}
            isSaving={isSavingTelegramSettings}
            isSettingsLoading={isSettingsLoading}
            hasToken={telegramHasToken}
          />

          <BitrixSettingsPanel
            draft={bitrixSettingsDraft}
            setDraft={setBitrixSettingsDraft}
            onSubmit={handleSaveBitrixSettings}
            isSaving={isSavingBitrixSettings}
            isSettingsLoading={isSettingsLoading}
            hasWebhook={bitrixHasWebhook}
          />

          <section className="status-line" aria-live="polite">
            {status || 'Настройки будут применены к следующим отправкам протоколов.'}
          </section>
        </section>
      ) : (
        <>
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

        <form className="meeting-bot-form" onSubmit={handleJoinMeeting}>
          <input
            value={meetingBotDraft.meetingUrl}
            onChange={(event) => setMeetingBotDraft((current) => ({ ...current, meetingUrl: event.target.value }))}
            placeholder="Ссылка на встречу (Zoom, Meet, Телемост...)"
          />
          <input
            value={meetingBotDraft.title}
            onChange={(event) => setMeetingBotDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="Название встречи (необязательно)"
          />
          <button className="button button-secondary" type="submit" disabled={isJoiningMeeting}>
            {isJoiningMeeting ? 'Отправляем...' : 'Пригласить бота'}
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

          {hasRecordings ? (
            <div className="recording-cards">
              {sortedRecordings.map((recording) => (
                <RecordingCard
                  key={recording.id}
                  recording={recording}
                  isSelected={recording.id === selectedRecordingId}
                  onSelect={setSelectedRecordingId}
                  onDelete={handleDelete}
                  onProcess={handleProcess}
                  isDeleting={deletingId === recording.id}
                  enableSwipe={isMobile}
                />
              ))}
            </div>
          ) : null}
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

              {selectedRecording.source === 'meeting_bot' ? (
                <section className="detail-section meeting-bot-status">
                  <h3>Бот на встрече</h3>
                  <p className="muted-text">
                    Ссылка:{' '}
                    <a href={selectedRecording.meetingUrl} target="_blank" rel="noreferrer">
                      {selectedRecording.meetingUrl}
                    </a>
                  </p>
                  {selectedRecording.status === 'queued' || selectedRecording.status === 'processing' ? (
                    <>
                      <p className="muted-text">Бот подключается или уже записывает встречу. Транскрипт появится автоматически после её завершения.</p>
                      <button
                        className="button button-danger"
                        type="button"
                        onClick={() => handleStopMeetingBot(selectedRecording)}
                        disabled={isStoppingMeetingBot}
                      >
                        {isStoppingMeetingBot ? 'Останавливаем...' : 'Остановить бота'}
                      </button>
                    </>
                  ) : null}
                </section>
              ) : null}

              <div className="detail-actions">
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => handleProcess(selectedRecording)}
                  disabled={!canProcessSelected}
                >
                  {processingId === selectedRecording.id ? 'Запускаем...' : 'Запустить обработку'}
                </button>
                <div className="summary-length-toggle" role="group" aria-label="Длина резюме">
                  {[
                    { value: 'brief', label: 'Кратко' },
                    { value: 'medium', label: 'Средне' },
                    { value: 'long', label: 'Подробно' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`summary-length-option${summaryLength === option.value ? ' active' : ''}`}
                      onClick={() => setSummaryLength(option.value)}
                      disabled={isSummarizing}
                      aria-pressed={summaryLength === option.value}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => handleSummarize(selectedRecording)}
                  disabled={!selectedRecording.transcript || isSummarizing}
                >
                  {isSummarizing ? 'Готовим...' : 'Сделать протокол'}
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => handleCopyExport(selectedRecording)}
                  disabled={!canExportSelected}
                >
                  Скопировать
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => handleDownloadExport(selectedRecording)}
                  disabled={!canExportSelected}
                >
                  Скачать .md
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

              <form className="email-send-panel" onSubmit={handleSendEmail}>
                <h3>Email</h3>
                <label>
                  Получатели
                  <input
                    value={emailDraft.recipients}
                    onChange={(event) => setEmailDraft((current) => ({ ...current, recipients: event.target.value }))}
                    placeholder="name@example.com, team@example.com"
                  />
                </label>
                <label>
                  Комментарий
                  <textarea
                    value={emailDraft.message}
                    onChange={(event) => setEmailDraft((current) => ({ ...current, message: event.target.value }))}
                    rows={3}
                    placeholder="Короткое сопроводительное сообщение"
                  />
                </label>
                <button className="button button-secondary" type="submit" disabled={!canExportSelected || isSendingEmail}>
                  {isSendingEmail ? 'Отправляем...' : 'Отправить протокол'}
                </button>
              </form>

              <form className="email-send-panel" onSubmit={handleSendTelegram}>
                <h3>Telegram</h3>
                <label>
                  Chat ID (необязательно)
                  <input
                    value={telegramDraft.chatId}
                    onChange={(event) => setTelegramDraft((current) => ({ ...current, chatId: event.target.value }))}
                    placeholder="По умолчанию из настроек"
                  />
                </label>
                <label>
                  Комментарий
                  <textarea
                    value={telegramDraft.message}
                    onChange={(event) => setTelegramDraft((current) => ({ ...current, message: event.target.value }))}
                    rows={3}
                    placeholder="Короткое сопроводительное сообщение"
                  />
                </label>
                <button className="button button-secondary" type="submit" disabled={!canExportSelected || isSendingTelegram}>
                  {isSendingTelegram ? 'Отправляем...' : 'Отправить в Telegram'}
                </button>
              </form>

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

              <section className="detail-section detail-section-wide">
                <h3>Стенограмма</h3>
                {selectedRecording.transcript ? (
                  <p className="transcript-text">{selectedRecording.transcript.text}</p>
                ) : (
                  <p className="muted-text">Стенограммы пока нет. Запусти обработку записи.</p>
                )}
              </section>

              <section className="detail-section">
                <div className="speaker-section-header">
                  <h3>Спикеры</h3>
                  {selectedRecording.speakers?.length ? (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={handleMatchSpeakersToBitrix}
                      disabled={isLoadingSpeakerMatches}
                    >
                      {isLoadingSpeakerMatches ? 'Ищем...' : 'Подобрать по Битрикс24'}
                    </button>
                  ) : null}
                </div>
                {selectedRecording.speakers?.length ? (
                  <div className="speaker-list">
                    {selectedRecording.speakers.map((speaker) => (
                      <SpeakerRow
                        key={speaker.label}
                        speaker={speaker}
                        draft={getSpeakerDraft(speaker)}
                        isSaving={savingSpeakerLabel === speaker.label}
                        match={speakerMatches[speaker.label]}
                        isSpeakerSaved={Boolean(speaker.id) && !speakerDrafts[speaker.label]}
                        onDraftChange={updateSpeakerDraft}
                        onApplyCandidate={applySpeakerCandidate}
                        onSave={handleSaveSpeaker}
                      />
                    ))}
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
                <section className="detail-section detail-section-wide">
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

              <section className="detail-section detail-section-wide">
                <h3>Задачи</h3>
                <form className="task-row task-create-form" onSubmit={handleAddTask}>
                  <div className="task-row-header">
                    <strong>Новая задача</strong>
                  </div>

                  <TaskForm draft={newTaskDraft} onFieldChange={updateNewTaskDraft} />

                  <button className="button button-primary" type="submit" disabled={isAddingTask}>
                    {isAddingTask ? 'Добавляем...' : 'Добавить задачу'}
                  </button>
                </form>

                {selectedRecording.tasks?.length ? (
                  <div className="task-list">
                    {selectedRecording.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        draft={getTaskDraft(task)}
                        isSaving={savingTaskId === task.id}
                        isDeleting={deletingTaskId === task.id}
                        isSendingBitrix={isSendingBitrixTaskId === task.id}
                        onFieldChange={updateTaskDraft}
                        onSave={handleSaveTask}
                        onConfirm={handleConfirmTask}
                        onDismiss={handleDismissTask}
                        onDelete={handleDeleteTask}
                        onSendToBitrix={handleSendTaskToBitrix}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="muted-text">Задач пока нет. Они появятся после генерации протокола, если модель найдёт поручения.</p>
                )}
              </section>

              <JobsList
                jobs={selectedRecording.jobs}
                isCollapsed={isJobsCollapsed}
                onToggleCollapse={() => setIsJobsCollapsed((current) => !current)}
              />
            </>
          ) : null}
        </aside>
      </section>
        </>
      )}
    </main>
  );
}

export default App;
