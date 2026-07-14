import { useEffect, useMemo, useState } from 'react';
import './App.css';
import Topbar from './components/Topbar.jsx';
import RecordingCard from './components/RecordingCard.jsx';
import ContactsPage from './components/ContactsPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import LibraryControls from './components/LibraryControls.jsx';
import RecordingDetail from './components/RecordingDetail.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import VoicePanel from './components/VoicePanel/VoicePanel.jsx';
import useMicRecorder from './hooks/useMicRecorder.js';
import useIsMobile from './hooks/useIsMobile.js';
import useUiStore from './store/uiStore.js';
import useSettings from './hooks/useSettings.js';
import useContacts from './hooks/useContacts.js';
import useTasks from './hooks/useTasks.js';
import useSpeakers from './hooks/useSpeakers.js';
import { apiFetch, isProcessingStatus } from './lib/api.js';
import {
  buildRecordingExport,
  buildProtocolDocxBlob,
  createExportFilename,
  exportBaseName,
  copyText,
  downloadBlob,
  downloadTextFile,
} from './lib/exporters.js';
import {
  isNetworkFailure,
  cacheRecordingsList,
  cacheRecordingDetail,
  offlineRecordingsList,
  offlineRecordingDetail,
  cacheProjects,
  offlineProjects,
} from './lib/recordingsRepo.js';
import { clearOfflineCache, putCachedCurrentUser, getCachedCurrentUser, getQueueItem } from './lib/offlineDb.js';
import { enqueueRecording, processQueue, getQueueSnapshot, toSyntheticRecording } from './lib/syncEngine.js';

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
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [recordingDraft, setRecordingDraft] = useState({ title: '', projectId: '', meetingType: 'meeting' });
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
  const [emailDraft, setEmailDraft] = useState({ recipients: '', message: '' });
  const [telegramDraft, setTelegramDraft] = useState({ chatId: '', message: '' });
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [processingId, setProcessingId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [isJobsCollapsed, setIsJobsCollapsed] = useState(false);

  const settings = useSettings(setStatus);
  const contactsPage = useContacts(setStatus);
  const tasks = useTasks({ selectedRecording, setSelectedRecording, setStatus, loadRecordingDetail });
  const speakers = useSpeakers({ selectedRecording, setSelectedRecording, setRecordings, setStatus });

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
    selectedRecording && !isProcessingStatus(selectedRecording.status) && processingId !== selectedRecording.id;
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

      if (data.user) {
        putCachedCurrentUser(data.user);
      }
    } catch (error) {
      if (isNetworkFailure(error)) {
        const cached = await getCachedCurrentUser();
        setCurrentUser(cached);

        if (cached) {
          setStatus('Офлайн — вход подтверждён по сохранённым данным');
        }

        return;
      }

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
      putCachedCurrentUser(data.user);
      setAuthMessage('');
    } catch (error) {
      setAuthMessage(error.message || 'Ошибка авторизации');
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    const pending = await getQueueSnapshot();

    if (pending.length > 0) {
      // The write queue can hold audio that only exists on this device -
      // wiping it on logout (clearOfflineCache does, since a different user
      // could log in next) would silently destroy unsynced recordings.
      // Refuse instead, so the user gets a chance to reconnect and sync.
      setStatus(
        `Есть ${pending.length} несинхронизированных записей — дождитесь синхронизации, прежде чем выходить, иначе они будут потеряны.`,
      );
      return;
    }

    await apiFetch('/api/auth/logout', {
      method: 'POST',
    }).catch(() => null);

    await clearOfflineCache();

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
      const nextProjects = data.projects || [];
      setProjects(nextProjects);
      cacheProjects(nextProjects);
    } catch (error) {
      if (isNetworkFailure(error)) {
        setProjects(await offlineProjects());
        return;
      }

      setStatus(error.message || 'Ошибка загрузки проектов');
    }
  }

  async function withQueuedRecordings(baseRecordings) {
    const queueItems = await getQueueSnapshot();
    // A queue item's server-side row is created before its audio finishes
    // uploading (see syncOneItem), so its id can already appear in
    // baseRecordings while sync is still in progress or has failed. The
    // synthetic (syncState-carrying) card always wins over that bare row -
    // otherwise a reload mid-sync silently hides the pending/failed pill
    // even though the recording isn't actually done syncing yet.
    const queuedServerIds = new Set(queueItems.map((item) => item.serverRecordingId).filter(Boolean));
    const filteredBase = baseRecordings.filter((recording) => !queuedServerIds.has(recording.id));
    const pending = queueItems.map(toSyntheticRecording);

    return [...pending, ...filteredBase];
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
      const serverRecordings = data.recordings || [];
      cacheRecordingsList(serverRecordings);

      const merged = await withQueuedRecordings(serverRecordings);
      setRecordings(merged);

      const fallbackId = merged[0]?.id || null;
      const existingId = merged.some((recording) => recording.id === nextSelectedId) ? nextSelectedId : fallbackId;
      setSelectedRecordingId(existingId);
      setStatus('');

      return merged;
    } catch (error) {
      if (isNetworkFailure(error)) {
        const cached = await offlineRecordingsList();
        const merged = await withQueuedRecordings(cached);
        setRecordings(merged);

        const fallbackId = merged[0]?.id || null;
        const existingId = merged.some((recording) => recording.id === nextSelectedId) ? nextSelectedId : fallbackId;
        setSelectedRecordingId(existingId);
        setStatus(merged.length ? 'Офлайн — показаны сохранённые записи' : 'Офлайн, сохранённых записей ещё нет');

        return merged;
      }

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

    if (recordingId.startsWith('local-')) {
      // Still only in the write queue - the backend has never heard of this
      // id, so render it straight from the queue instead of hitting the API.
      const queueItem = await getQueueItem(recordingId);
      setSelectedRecording(queueItem ? toSyntheticRecording(queueItem) : null);
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
      cacheRecordingDetail(data.recording);
    } catch (error) {
      if (isNetworkFailure(error)) {
        const cached = await offlineRecordingDetail(recordingId);

        if (cached) {
          setSelectedRecording(cached);
          if (!options.quiet) {
            setStatus('Офлайн — показана сохранённая версия записи');
          }
        } else {
          setSelectedRecording(null);
          if (!options.quiet) {
            setStatus('Офлайн, эта запись ещё не сохранена на устройстве');
          }
        }

        return;
      }

      setStatus(error.message || 'Не удалось открыть запись');
      setSelectedRecording(null);
    } finally {
      if (!options.quiet) {
        setIsDetailLoading(false);
      }
    }
  }

  async function loadNotifications() {
    try {
      const response = await apiFetch('/api/notifications');
      const data = await response.json();

      if (!response.ok) {
        return;
      }

      setNotifications(data.notifications || []);
      setUnreadNotificationCount(data.unreadCount || 0);
    } catch {
      // Best-effort background poll - a transient failure just tries again
      // on the next interval tick, no need to surface it to the user.
    }
  }

  async function handleOpenNotification(notification) {
    setIsNotificationsOpen(false);

    if (!notification.readAt) {
      await apiFetch(`/api/notifications/${notification.id}/read`, { method: 'POST' }).catch(() => null);
      setNotifications((current) => current.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)));
      setUnreadNotificationCount((current) => Math.max(0, current - 1));
    }

    if (notification.recordingId) {
      setActivePage('library');
      setSelectedRecordingId(notification.recordingId);
    }
  }

  useEffect(() => {
    loadCurrentUser();
  }, []);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      processQueue(apiFetch, syncCallbacks).catch((error) => {
        console.error('processQueue failed', error);
      });
    }

    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    // Resume anything left in the write queue from a previous session (a
    // recording synced up to some offset, then the tab closed/crashed).
    processQueue(apiFetch, syncCallbacks).catch((error) => {
      console.error('processQueue failed', error);
    });
  }, [currentUser?.id]);

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
      settings.loadAllSettings();
    }
  }, [currentUser?.id, activePage]);

  useEffect(() => {
    if (currentUser && activePage === 'contacts') {
      contactsPage.loadContacts();
    }
  }, [currentUser?.id, activePage]);

  // Global, low-frequency poll (distinct from the 2s per-recording status
  // poll elsewhere) - notifications can arrive for any recording, not just
  // the one currently open, so this has to run independently of selection.
  useEffect(() => {
    if (!currentUser) {
      return undefined;
    }

    loadNotifications();
    const intervalId = window.setInterval(loadNotifications, 20000);
    return () => window.clearInterval(intervalId);
  }, [currentUser?.id]);

  useEffect(() => {
    setRecordingDraft({
      title: selectedRecording?.title || '',
      projectId: selectedRecording?.projectId || '',
      meetingType: selectedRecording?.meetingType || 'meeting',
    });
  }, [selectedRecording?.id, selectedRecording?.title, selectedRecording?.projectId, selectedRecording?.meetingType]);

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
          meetingType: recordingDraft.meetingType,
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

  function handleSyncItemChange(localId, patch) {
    setRecordings((current) =>
      current.map((recording) => {
        if (recording.id !== localId) {
          return recording;
        }

        const merged = { ...recording, ...patch };

        if (patch.bytesAcked !== undefined && recording.fileSizeBytes) {
          merged.syncProgress = patch.bytesAcked / recording.fileSizeBytes;
        }

        return merged;
      }),
    );
  }

  function handleSyncSuccess(localId, serverRecording) {
    setRecordings((current) => current.map((recording) => (recording.id === localId ? serverRecording : recording)));
    setSelectedRecordingId((current) => (current === localId ? serverRecording.id : current));
    setSelectedRecording((current) => (current?.id === localId ? serverRecording : current));
    cacheRecordingDetail(serverRecording);
  }

  function handleSyncFailure(localId, updatedQueueItem) {
    setRecordings((current) =>
      current.map((recording) =>
        recording.id === localId
          ? { ...recording, syncState: 'sync-failed', syncError: updatedQueueItem?.lastError }
          : recording,
      ),
    );
  }

  const syncCallbacks = {
    onItemChange: handleSyncItemChange,
    onSynced: handleSyncSuccess,
    onFailed: handleSyncFailure,
  };

  async function uploadRecordingFile(file, source = 'frontend-upload') {
    setIsUploading(true);

    try {
      const title = file.name.replace(/\.[^.]+$/, '') || file.name;
      const queueItem = await enqueueRecording(file, title, source);

      setRecordings((current) => [toSyntheticRecording(queueItem), ...current]);
      setSelectedRecordingId(queueItem.localId);
      setStatus(
        navigator.onLine
          ? `Сохранено, синхронизируем «${title}»...`
          : `Сохранено на устройстве — синхронизируем, когда появится сеть`,
      );

      // The recording is already safe in IndexedDB regardless of how long
      // sync takes, so this deliberately isn't awaited - the UI shouldn't
      // block on the network round-trip.
      processQueue(apiFetch, syncCallbacks).catch((error) => {
        console.error('processQueue failed', error);
      });
    } catch (error) {
      setStatus(error.message || 'Не удалось сохранить запись');
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

  async function handleCancelProcessing(recording) {
    if (!recording) {
      return;
    }

    setCancellingId(recording.id);
    setStatus(`Отменяем обработку "${recording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/jobs/cancel`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Не удалось отменить обработку');
      }

      // Cancellation of an already-running job is cooperative - the worker
      // stops at its next checkpoint rather than instantly, so the status
      // right after this call may still briefly show as processing until
      // the next poll picks up the final 'failed' state.
      await loadRecordings(recording.id);
      await loadRecordingDetail(recording.id);
      setStatus(`Отмена "${recording.title}" запрошена`);
    } catch (error) {
      setStatus(error.message || 'Ошибка отмены обработки');
    } finally {
      setCancellingId(null);
    }
  }

  async function handleSummarize(recording, { instruction } = {}) {
    if (!recording?.transcript) {
      setStatus('Сначала нужна стенограмма');
      return;
    }

    setIsSummarizing(true);
    setStatus(`Готовим протокол "${recording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/summary`, {
        method: 'POST',
        body: JSON.stringify({ length: summaryLength, instruction, timezoneOffsetMinutes: new Date().getTimezoneOffset() }),
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
      throw error;
    } finally {
      setIsSummarizing(false);
    }
  }

  async function handleUpdateProtocol(payload) {
    const recording = selectedRecording;

    if (!recording) {
      throw new Error('Запись не выбрана');
    }

    const response = await apiFetch(`/api/recordings/${recording.id}/summary`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось обновить протокол');
    }

    setSelectedRecording((current) => (current?.id === recording.id ? { ...current, summary: data.summary } : current));
    setRecordings((current) => current.map((item) => (item.id === recording.id ? { ...item, summary: data.summary } : item)));

    return data.summary;
  }

  async function handleDictateVoiceNote(blob) {
    const formData = new FormData();
    const extension = blob.type.includes('ogg') ? 'ogg' : 'webm';
    formData.append('file', blob, `voice-note.${extension}`);

    const response = await apiFetch('/api/voice-note-transcript', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось распознать надиктовку');
    }

    return data.text || '';
  }

  async function handleUpdateTranscript(payload) {
    const recording = selectedRecording;

    if (!recording) {
      throw new Error('Запись не выбрана');
    }

    const response = await apiFetch(`/api/recordings/${recording.id}/transcript`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось обновить стенограмму');
    }

    setSelectedRecording((current) => (current?.id === recording.id ? { ...current, transcript: data.transcript } : current));
    setRecordings((current) => current.map((item) => (item.id === recording.id ? { ...item, transcript: data.transcript } : item)));

    return data.transcript;
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

  async function handleDownloadDocxExport(recording) {
    if (!recording) {
      return;
    }

    try {
      const blob = await buildProtocolDocxBlob(recording);
      downloadBlob(`${exportBaseName(recording)}-protocol.docx`, blob);
      setStatus(`Экспорт "${recording.title}" (.docx) скачан`);
    } catch (error) {
      setStatus(error.message || 'Не удалось собрать .docx');
    }
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
        isOnline={isOnline}
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
        notifications={notifications}
        unreadNotificationCount={unreadNotificationCount}
        isNotificationsOpen={isNotificationsOpen}
        setIsNotificationsOpen={setIsNotificationsOpen}
        onOpenNotification={handleOpenNotification}
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
        <SettingsPage settings={settings} micDeviceId={micDeviceId} setMicDeviceId={setMicDeviceId} status={status} />
      ) : activePage === 'contacts' ? (
        <ContactsPage
          contacts={contactsPage.contacts}
          isLoadingContacts={contactsPage.isLoadingContacts}
          contactDraft={contactsPage.contactDraft}
          setContactDraft={contactsPage.setContactDraft}
          isCreatingContact={contactsPage.isCreatingContact}
          contactDuplicate={contactsPage.contactDuplicate}
          onCreateContact={contactsPage.handleCreateContact}
          onResolveContactDuplicate={contactsPage.handleResolveContactDuplicate}
          onCancelContactDuplicate={contactsPage.handleCancelContactDuplicate}
          getContactDraft={contactsPage.getContactDraft}
          onContactDraftChange={contactsPage.handleContactDraftChange}
          savingContactId={contactsPage.savingContactId}
          deletingContactId={contactsPage.deletingContactId}
          onSaveContact={contactsPage.handleSaveContact}
          onDeleteContact={contactsPage.handleDeleteContact}
          isImportingContacts={contactsPage.isImportingContacts}
          contactImportSummary={contactsPage.contactImportSummary}
          onImportFile={contactsPage.handleImportContactsFile}
          onImportBitrix={contactsPage.handleImportContactsFromBitrix}
        />
      ) : (
        <>
          <LibraryControls
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            projectFilter={projectFilter}
            setProjectFilter={setProjectFilter}
            projectOptions={projectOptions}
            newProjectDraft={newProjectDraft}
            setNewProjectDraft={setNewProjectDraft}
            isCreatingProject={isCreatingProject}
            onCreateProject={handleCreateProject}
            meetingBotDraft={meetingBotDraft}
            setMeetingBotDraft={setMeetingBotDraft}
            isJoiningMeeting={isJoiningMeeting}
            onJoinMeeting={handleJoinMeeting}
          />

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
                <RecordingDetail
                  recording={selectedRecording}
                  canProcess={canProcessSelected}
                  canExport={canExportSelected}
                  processingId={processingId}
                  cancellingId={cancellingId}
                  onProcess={handleProcess}
                  onCancelProcessing={handleCancelProcessing}
                  isStoppingMeetingBot={isStoppingMeetingBot}
                  onStopMeetingBot={handleStopMeetingBot}
                  summaryLength={summaryLength}
                  setSummaryLength={setSummaryLength}
                  isSummarizing={isSummarizing}
                  onSummarize={handleSummarize}
                  onCopyExport={handleCopyExport}
                  onDownloadExport={handleDownloadExport}
                  onDownloadDocxExport={handleDownloadDocxExport}
                  recordingDraft={recordingDraft}
                  setRecordingDraft={setRecordingDraft}
                  projectOptions={projectOptions}
                  isGeneratingTitle={isGeneratingTitle}
                  onGenerateTitle={handleGenerateTitle}
                  isSavingRecording={isSavingRecording}
                  onSaveRecordingMetadata={handleSaveRecordingMetadata}
                  emailDraft={emailDraft}
                  setEmailDraft={setEmailDraft}
                  isSendingEmail={isSendingEmail}
                  onSendEmail={handleSendEmail}
                  telegramDraft={telegramDraft}
                  setTelegramDraft={setTelegramDraft}
                  isSendingTelegram={isSendingTelegram}
                  onSendTelegram={handleSendTelegram}
                  onUpdateTranscript={handleUpdateTranscript}
                  onUpdateProtocol={handleUpdateProtocol}
                  onDictate={handleDictateVoiceNote}
                  setStatus={setStatus}
                  tasks={tasks}
                  speakers={speakers}
                  isJobsCollapsed={isJobsCollapsed}
                  onToggleJobsCollapsed={() => setIsJobsCollapsed((current) => !current)}
                />
              ) : null}
            </aside>
          </section>
        </>
      )}
    </main>
  );
}

export default App;
