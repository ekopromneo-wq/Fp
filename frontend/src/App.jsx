import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import Topbar from './components/Topbar.jsx';
import BottomNav from './components/BottomNav.jsx';
import RecordingCard from './components/RecordingCard.jsx';
import ContactsPage from './components/ContactsPage.jsx';
import HomePage from './components/HomePage.jsx';
import ProjectsPage from './components/ProjectsPage.jsx';
import TaskSearchPage from './components/TaskSearchPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import LibraryControls from './components/LibraryControls.jsx';
import RecordingDetail from './components/RecordingDetail.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import LinkEmailScreen from './components/LinkEmailScreen.jsx';
import SharePage from './components/SharePage.jsx';
import VoicePanel from './components/VoicePanel/VoicePanel.jsx';
import ConsentDialog from './components/ConsentDialog.jsx';
import useMicRecorder from './hooks/useMicRecorder.js';
import useIsMobile from './hooks/useIsMobile.js';
import useUiStore from './store/uiStore.js';
import useSettings from './hooks/useSettings.js';
import useContacts from './hooks/useContacts.js';
import useProjects from './hooks/useProjects.js';
import useTaskSearch from './hooks/useTaskSearch.js';
import useTasks from './hooks/useTasks.js';
import useSpeakers from './hooks/useSpeakers.js';
import useSending from './hooks/useSending.js';
import { apiFetch, isProcessingStatus, track } from './lib/api.js';
import { formatDate, pluralizeRu } from './lib/format.js';
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
import {
  clearOfflineCache,
  putCachedCurrentUser,
  getCachedCurrentUser,
  getQueueItem,
  getActiveRecordingSession,
  getLiveRecordingChunks,
  clearLiveRecordingSession,
} from './lib/offlineDb.js';
import { enqueueRecording, processQueue, getQueueSnapshot, toSyntheticRecording } from './lib/syncEngine.js';
import { uploadBlobInChunks } from './lib/chunkedUploader.js';

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [consentPromptOpen, setConsentPromptOpen] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [oauthProviders, setOauthProviders] = useState([]);
  const [telegramLogin, setTelegramLogin] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  // Ошибка OAuth приходит редиректом ?auth_error=... — показываем на экране входа
  // и чистим адрес.
  const [authMessage, setAuthMessage] = useState(() => {
    const error = new URLSearchParams(window.location.search).get('auth_error');
    if (error) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    return error || '';
  });
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  // ADR-034: провайдер без пригодного email вернул токен «висящего» линка через
  // ?link_email=... — показываем экран «подтвердите email». Читаем один раз при
  // монтировании и чистим адрес.
  const [linkEmail, setLinkEmail] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('link_email');
    if (!token) {
      return null;
    }
    window.history.replaceState({}, '', window.location.pathname);
    return { token, provider: params.get('provider') || '' };
  });
  const [linkEmailNeedsPassword, setLinkEmailNeedsPassword] = useState(false);
  const [recordings, setRecordings] = useState([]);
  const [projects, setProjects] = useState([]);
  // Токен читается один раз при монтировании: смена адреса без роутера всё
  // равно перезагружает страницу.
  const [shareToken] = useState(() => new URLSearchParams(window.location.search).get('share'));
  // US-13.1: приложение открывается на контекстном главном экране.
  // Страница переживает перезагрузку (F5/обновление PWA) — иначе любой рефреш
  // выкидывал на «Главную».
  const [activePage, setActivePage] = useState(() => {
    try {
      const saved = localStorage.getItem('stenogram-active-page');
      return ['home', 'library', 'settings', 'projects', 'tasksearch', 'contacts'].includes(saved) ? saved : 'home';
    } catch {
      return 'home';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('stenogram-active-page', activePage);
    } catch {
      // localStorage может быть недоступен — не критично.
    }
  }, [activePage]);
  const [trashMode, setTrashMode] = useState(false);
  const [selectedRecordingId, setSelectedRecordingId] = useState(null);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [status, setStatus] = useState('Загружаем записи...');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [libraryFilters, setLibraryFilters] = useState({
    dateFrom: '',
    dateTo: '',
    status: '',
    source: '',
    meetingType: '',
    participant: '',
    hasTasks: '',
  });
  const [recordingDraft, setRecordingDraft] = useState({ title: '', projectIds: [], meetingType: 'meeting', asrHints: '' });
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
  const [sendConfig, setSendConfig] = useState(null);
  const [accountConfig, setAccountConfig] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [processingId, setProcessingId] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // #3: групповое удаление встреч из библиотеки.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isJobsCollapsed, setIsJobsCollapsed] = useState(false);

  const settings = useSettings(setStatus, setSendConfig);
  const contactsPage = useContacts(setStatus);
  const projectsPage = useProjects(setStatus, loadProjects);
  const taskSearch = useTaskSearch(setStatus);
  const tasks = useTasks({ selectedRecording, setSelectedRecording, setStatus, loadRecordingDetail });
  const speakers = useSpeakers({ selectedRecording, setSelectedRecording, setRecordings, setStatus });
  // Получателей подставляем из почт спикеров встречи: чаще всего протокол уходит
  // именно участникам.
  const speakerRecipients = useMemo(
    () => [...new Set((selectedRecording?.speakers || []).map((speaker) => speaker.contactEmail).filter(Boolean))].join(', '),
    [selectedRecording?.id, selectedRecording?.speakers],
  );
  const sending = useSending({
    recordingId: selectedRecording?.id || null,
    sendConfig,
    setStatus,
    defaultRecipients: speakerRecipients,
  });

  const micDeviceId = useUiStore((state) => state.micDeviceId);
  const hiddenHomeBlocks = useUiStore((state) => state.hiddenHomeBlocks);
  const toggleHomeBlock = useUiStore((state) => state.toggleHomeBlock);
  const setMicDeviceId = useUiStore((state) => state.setMicDeviceId);
  // US-3.4: запрет выгрузки по мобильной сети + ручная синхронизация.
  const blockMobileUpload = useUiStore((state) => state.blockMobileUpload);
  const setBlockMobileUpload = useUiStore((state) => state.setBlockMobileUpload);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [isManualSyncing, setIsManualSyncing] = useState(false);

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
  // US-16.3: предупреждение о согласии участников перед КАЖДОЙ записью
  // (152-ФЗ). Только при старте (не остановке) и если настройка включена.
  // Показываем диалог с веткой отказа; доказательство пишет сам диалог.
  function startRecordingWithConsent() {
    if (!isMicRecording && accountConfig?.recordingConsentWarning !== false) {
      setConsentPromptOpen(true);
      return;
    }

    handleMicRecordingToggle();
  }

  // Мобильный: тап по микрофону сразу ведёт в согласие/запись (панель открывается
  // фоном без промежуточного «Готово к записи»); во время записи — просто панель.
  const handleMicButtonClick = isMobile
    ? () => {
        openVoicePanel();
        if (!isMicRecording) {
          startRecordingWithConsent();
        }
      }
    : startRecordingWithConsent;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // US-16.5: результат подключения календаря приходит редиректом.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('calendar') === 'connected') {
      setStatus('Календарь подключён — напомним перед встречей');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('calendar_error')) {
      setStatus(params.get('calendar_error'));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const hasRecordings = recordings.length > 0;
  // #10: сортировка встреч по времени создания (новые сверху по умолчанию).
  const [sortOrder, setSortOrder] = useState('desc');
  const sortedRecordings = useMemo(() => {
    const list = [...recordings];
    list.sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return sortOrder === 'asc' ? ta - tb : tb - ta;
    });
    return list;
  }, [recordings, sortOrder]);
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
      setRegistrationEnabled(data.registrationEnabled !== false);
      setOauthProviders(data.oauthProviders || []);
      setTelegramLogin(data.telegramLogin || null);

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

  // ADR-034: завершение входа через шаг «подтвердите email».
  async function handleCompleteOauth(input) {
    setIsAuthSubmitting(true);
    setAuthMessage('');

    try {
      const response = await apiFetch('/api/auth/oauth/complete', {
        method: 'POST',
        body: JSON.stringify({ token: linkEmail.token, ...input }),
      });
      const data = await response.json();

      if (!response.ok) {
        // Занятый email → сервер просит пароль от аккаунта: раскрываем поле.
        if (data.needsPassword) {
          setLinkEmailNeedsPassword(true);
        }
        throw new Error(data.error || 'Не удалось завершить вход');
      }

      setCurrentUser(data.user);
      putCachedCurrentUser(data.user);
      setLinkEmail(null);
      setLinkEmailNeedsPassword(false);
      setAuthMessage('');
    } catch (error) {
      setAuthMessage(error.message || 'Не удалось завершить вход');
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  function handleLoggedOut() {
    // Аккаунт удалён на сервере — просто сбрасываем клиент, без /logout.
    clearOfflineCache().catch(() => null);
    setCurrentUser(null);
    setRecordings([]);
    setProjects([]);
    setActivePage('home');
    setSelectedRecordingId(null);
    setSelectedRecording(null);
    setStatus('Аккаунт удалён');
  }

  async function handleLogout() {
    const snapshot = await getQueueSnapshot();
    // Тупиковые сбои не выгрузить — они не должны вечно блокировать выход
    // «дождитесь синхронизации»; их можно только удалить.
    const pending = snapshot.filter((item) => !(item.syncState === 'sync-failed' && item.syncPermanent));

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

      Object.entries(libraryFilters).forEach(([key, value]) => {
        if (value) {
          params.set(key, value);
        }
      });

      if (trashMode) {
        params.set('trash', 'only');
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

      // На мобильном деталь открывается на весь экран, поэтому запись не выбираем
      // автоматически (иначе список сразу подменяется деталью) — только по тапу.
      // На десктопе мастер-детейл показывает первую запись как раньше.
      const fallbackId = isMobile ? null : (merged[0]?.id || null);
      const existingId = merged.some((recording) => recording.id === nextSelectedId) ? nextSelectedId : fallbackId;
      setSelectedRecordingId(existingId);
      setStatus('');

      return merged;
    } catch (error) {
      if (isNetworkFailure(error)) {
        const cached = await offlineRecordingsList();
        const merged = await withQueuedRecordings(cached);
        setRecordings(merged);

        const fallbackId = isMobile ? null : (merged[0]?.id || null);
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
      // US-3 offline recovery rate (NFR §9): связь вернулась, а в очереди есть
      // несинхронизированные записи — фиксируем момент восстановления.
      getQueueSnapshot()
        .then((items) => {
          if (items.length > 0) {
            track('offline_recovery', { pending: items.length });
          }
        })
        .catch(() => {});
      runSync();
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
  }, [currentUser?.id, searchQuery, projectFilter, JSON.stringify(libraryFilters), trashMode]);

  useEffect(() => {
    if (currentUser) {
      loadRecordingDetail(selectedRecordingId);
    }
  }, [selectedRecordingId, currentUser?.id]);

  // На мобильном деталь открывается на весь экран поверх списка — прокручиваем
  // к началу, чтобы запись показалась с шапки, а не с позиции скролла списка.
  useEffect(() => {
    if (isMobile && selectedRecordingId) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [isMobile, selectedRecordingId]);

  useEffect(() => {
    if (currentUser && activePage === 'settings') {
      settings.loadAllSettings();
    }
  }, [currentUser?.id, activePage]);

  // Настройки отправки нужны панели отправки в деталях записи, а не только
  // странице настроек, — грузим сразу после входа.
  useEffect(() => {
    if (!currentUser) {
      return;
    }

    (async () => {
      try {
        const response = await apiFetch('/api/settings/send');
        const data = await response.json();

        if (response.ok) {
          setSendConfig(data.send);
        }
      } catch {
        // Панель отправки переживёт отсутствие настроек: у черновика есть
        // собственные значения по умолчанию.
      }

      try {
        const response = await apiFetch('/api/settings/account');
        const data = await response.json();

        if (response.ok) {
          setAccountConfig(data.account);
        }
      } catch {
        // Согласие спросим по умолчанию, если настройка не загрузилась.
      }
    })();
  }, [currentUser?.id]);

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

  const selectedProjectIds = (selectedRecording?.projects || []).map((project) => project.id);

  useEffect(() => {
    setRecordingDraft({
      title: selectedRecording?.title || '',
      projectIds: selectedProjectIds,
      meetingType: selectedRecording?.meetingType || 'meeting',
      asrHints: selectedRecording?.asrHints || '',
    });
  }, [
    selectedRecording?.id,
    selectedRecording?.title,
    selectedProjectIds.join(','),
    selectedRecording?.meetingType,
    selectedRecording?.asrHints,
  ]);


  // Переход к встрече из сводки проекта или результатов поиска задач.
  function openRecordingFromAnywhere(recordingId) {
    setActivePage('library');
    setSelectedRecordingId(recordingId);
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
          projectIds: recordingDraft.projectIds,
          meetingType: recordingDraft.meetingType,
          asrHints: recordingDraft.asrHints,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить запись');
      }

      setSelectedRecording((current) => (current?.id === data.recording.id ? { ...current, ...data.recording } : current));
      setRecordings((current) => current.map((recording) => (recording.id === data.recording.id ? { ...recording, ...data.recording } : recording)));
      // Счётчики встреч в проектах могли измениться вместе с привязкой.
      loadProjects();
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

  // US-2.2: сервер распознал, что этот же файл уже загружен. Даём выбор
  // «оставить обе / удалить дубль» — загрузку не откатываем автоматически.
  async function promptDuplicate(serverRecording) {
    const dup = serverRecording.duplicateOf;

    if (!dup) {
      return;
    }

    const removeThis = window.confirm(
      `Похоже, этот файл уже загружен как «${dup.title || 'другая встреча'}». Удалить эту копию? (Отмена — оставить обе.)`,
    );

    if (!removeThis) {
      setStatus('Оставили обе записи');
      return;
    }

    try {
      const response = await apiFetch(`/api/recordings/${serverRecording.id}`, { method: 'DELETE' });

      if (!response.ok) {
        throw new Error('Не удалось удалить дубль');
      }

      const nextSelectedId = selectedRecordingId === serverRecording.id ? dup.id : selectedRecordingId;
      setSelectedRecordingId(nextSelectedId);
      setSelectedRecording((current) => (current?.id === serverRecording.id ? null : current));
      await loadRecordings(nextSelectedId);
      setStatus('Дубль удалён');
    } catch (error) {
      setStatus(error.message || 'Не удалось удалить дубль');
    }
  }

  function handleSyncSuccess(localId, serverRecording) {
    // US-3.2: «две галочки — отправлено» показываем ненадолго, затем карточка
    // выглядит как обычная синхронизированная запись (без пилюли).
    const justSynced = { ...serverRecording, syncState: 'synced' };
    setRecordings((current) => current.map((recording) => (recording.id === localId ? justSynced : recording)));
    setSelectedRecordingId((current) => (current === localId ? serverRecording.id : current));
    setSelectedRecording((current) => (current?.id === localId ? justSynced : current));
    cacheRecordingDetail(serverRecording);
    refreshUnsyncedCount();

    setTimeout(() => {
      setRecordings((current) => current.map((recording) => (recording.id === serverRecording.id ? serverRecording : recording)));
      setSelectedRecording((current) => (current?.id === serverRecording.id ? serverRecording : current));
    }, 4000);

    if (serverRecording.duplicateOf) {
      promptDuplicate(serverRecording);
    }
  }

  function handleSyncFailure(localId, updatedQueueItem) {
    setRecordings((current) =>
      current.map((recording) =>
        recording.id === localId
          ? { ...recording, syncState: 'sync-failed', syncError: updatedQueueItem?.lastError, syncPermanent: Boolean(updatedQueueItem?.syncPermanent) }
          : recording,
      ),
    );
  }

  const syncCallbacks = {
    onItemChange: handleSyncItemChange,
    onSynced: handleSyncSuccess,
    onFailed: handleSyncFailure,
    onMeteredSkip: () => setStatus('Выгрузка отложена — вы в мобильной сети. Нажмите «Синхронизировать», чтобы отправить сейчас.'),
  };

  async function refreshUnsyncedCount() {
    try {
      const items = await getQueueSnapshot();
      // Тупиковые сбои (сервер отклонил файл) не «ждут синхронизации» — их не
      // выгрузить, только удалить, поэтому в счётчик несинхронизированных не берём.
      const pending = items.filter((item) => !(item.syncState === 'sync-failed' && item.syncPermanent));
      setUnsyncedCount(pending.length);
    } catch {
      // Снимок очереди — вспомогательный счётчик, его сбой не критичен.
    }
  }

  // US-3.4: единая точка запуска синхронизации. Авто-вызовы уважают запрет
  // мобильной сети; ручной (force) — заливает несмотря на неё.
  function runSync(options = {}) {
    // Читаем флаг из стора напрямую: часть вызовов живёт в once-эффектах, где
    // замкнутое значение из пропса устарело бы.
    const blockMetered = useUiStore.getState().blockMobileUpload;
    return processQueue(apiFetch, syncCallbacks, { blockMobileUpload: blockMetered, ...options })
      .catch((error) => console.error('processQueue failed', error))
      .finally(() => refreshUnsyncedCount());
  }

  async function handleManualSync() {
    setIsManualSyncing(true);
    setStatus('Синхронизируем...');

    try {
      await runSync({ force: true });
      setStatus('Синхронизация завершена');
    } finally {
      setIsManualSyncing(false);
    }
  }

  useEffect(() => {
    refreshUnsyncedCount();
  }, [currentUser?.id]);

  async function uploadRecordingFile(file, source = 'frontend-upload') {
    setIsUploading(true);

    try {
      // Микрофонная встреча получает человеческое имя «Встреча ДД.ММ.ГГГГ ЧЧ:ММ»
      // (правится вручную/AI-названием); файл — своё имя без расширения.
      const now = new Date();
      const title =
        source === 'frontend-microphone'
          ? `Встреча ${now.toLocaleDateString('ru-RU')} ${now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
          : file.name.replace(/\.[^.]+$/, '') || file.name;
      // US-3.5: режим «только на устройстве» — запись не выгружается и не
      // обрабатывается в облаке (осознанный выбор пользователя ради приватности).
      const deviceOnly = useUiStore.getState().storageMode === 'device';
      const queueItem = await enqueueRecording(file, title, source, { deviceOnly });

      setRecordings((current) => [toSyntheticRecording(queueItem), ...current]);
      // На мобильном не открываем деталь сразу — показываем список с новой записью
      // сверху (деталь на мобильном полноэкранная и скрыла бы библиотеку).
      setSelectedRecordingId(isMobile ? null : queueItem.localId);

      // Запись закончена/файл добавлен — ведём в «Записи», там виден статус
      // синхронизации и обработки. Панель записи закрываем.
      closeVoicePanel();
      setActivePage('library');

      if (deviceOnly) {
        setStatus(`Сохранено только на устройстве — «${title}» не выгружается`);
        // Намеренно НЕ запускаем синхронизацию: запись остаётся локальной.
        return;
      }

      setStatus(
        navigator.onLine
          ? `Сохранено, синхронизируем «${title}»...`
          : `Сохранено на устройстве — синхронизируем, когда появится сеть`,
      );

      // The recording is already safe in IndexedDB regardless of how long
      // sync takes, so this deliberately isn't awaited - the UI shouldn't
      // block on the network round-trip.
      runSync();
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

  // US-1.5: дозапись фрагмента к уже существующей (серверной) встрече. Грузим
  // файл в ту же встречу через чанковую сессию — бэкенд склеит его с текущим
  // аудио и пересоберёт протокол. Онлайн-действие поверх серверной записи,
  // поэтому мимо офлайн-очереди (у синтетической записи и аудио-то ещё нет).
  const [isAppendingFragment, setIsAppendingFragment] = useState(false);
  async function handleAppendFragment(recording, file) {
    if (!recording || !file || isAppendingFragment) {
      return;
    }

    setIsAppendingFragment(true);
    setStatus(`Добавляем фрагмент к «${recording.title || 'встрече'}»...`);

    try {
      const sessionResponse = await apiFetch(`/api/recordings/${recording.id}/upload-session`, {
        method: 'POST',
        body: JSON.stringify({
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          totalSizeBytes: file.size,
        }),
      });
      const sessionData = await sessionResponse.json();

      if (!sessionResponse.ok) {
        throw new Error(sessionData.error || 'Не удалось начать загрузку фрагмента');
      }

      const chunkSizeBytes = sessionData.session?.chunkSizeBytes || 5 * 1024 * 1024;
      const startOffset = sessionData.session?.bytesReceived || 0;
      await uploadBlobInChunks(apiFetch, recording.id, file, { chunkSizeBytes, startOffset });

      const completeResponse = await apiFetch(`/api/recordings/${recording.id}/upload-session/complete`, {
        method: 'POST',
      });
      const completeData = await completeResponse.json();

      if (!completeResponse.ok) {
        throw new Error(completeData.error || 'Не удалось объединить фрагмент со встречей');
      }

      setStatus('Фрагмент добавлен — встреча пересобрана и обрабатывается');
      await loadRecordings(recording.id);
    } catch (error) {
      setStatus(error.message || 'Не удалось добавить фрагмент');
    } finally {
      setIsAppendingFragment(false);
    }
  }

  // US-1.8: восстановление записи, оборвавшейся до «Стоп» (разряд, крэш вкладки,
  // случайное обновление страницы). Чанки лежат в IndexedDB — собираем файл и
  // ставим в ту же очередь отправки. Один раз за сессию, после появления юзера
  // (иначе processQueue не пройдёт авторизацию на сервере).
  const recoveryDoneRef = useRef(false);
  useEffect(() => {
    if (!currentUser || recoveryDoneRef.current) {
      return;
    }

    recoveryDoneRef.current = true;

    (async () => {
      try {
        const session = await getActiveRecordingSession();

        if (!session?.sessionId) {
          return;
        }

        const chunks = await getLiveRecordingChunks(session.sessionId);
        await clearLiveRecordingSession();

        if (!chunks.length) {
          return;
        }

        const mimeType = session.mimeType || 'audio/webm';
        const file = new File([new Blob(chunks, { type: mimeType })], session.filename || 'recovered-recording.webm', {
          type: mimeType,
        });

        await uploadRecordingFile(file, session.source || 'frontend-microphone');
        setStatus('Восстановлена прерванная запись');
      } catch (error) {
        console.error('live recording recovery failed', error);
      }
    })();
  }, [currentUser?.id]);

  // US-18.1: drag-and-drop файлов на ПК. На телефоне не показываем оверлей —
  // там перетаскивать нечем.
  const [isDragging, setIsDragging] = useState(false);

  function handleDragOver(event) {
    if (isMobile || isUploading || isMicRecording) {
      return;
    }

    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event) {
    // Уходим только когда курсор покинул окно, а не перешёл на дочерний элемент.
    if (event.relatedTarget === null) {
      setIsDragging(false);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);

    if (isMobile || isUploading || isMicRecording) {
      return;
    }

    const file = event.dataTransfer?.files?.[0];

    if (file) {
      await uploadRecordingFile(file);
    }
  }

  async function handleProcess(recording, { retranscribe = false } = {}) {
    if (!recording) {
      return;
    }

    // Перерасшифровка перезаписывает стенограмму и разметку спикеров — в том
    // числе ручные правки и имена, поэтому спрашиваем.
    if (retranscribe) {
      const confirmed = window.confirm(
        `Расшифровать "${recording.title}" заново?\n\nТекущая стенограмма, правки в ней и имена спикеров будут заменены результатом новой расшифровки.`,
      );

      if (!confirmed) {
        return;
      }
    }

    setProcessingId(recording.id);
    setStatus(retranscribe ? `Расшифровываем "${recording.title}" заново...` : `Запускаем обработку "${recording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/jobs`, {
        method: 'POST',
        body: JSON.stringify({ retranscribe }),
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

  async function handleSummarize(recording, { instruction, processingTemplate } = {}) {
    if (!recording?.transcript) {
      setStatus('Сначала нужна стенограмма');
      return;
    }

    setIsSummarizing(true);
    setStatus(`Готовим протокол "${recording.title}"...`);

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/summary`, {
        method: 'POST',
        body: JSON.stringify({
          // #9: явный выбор шаблона при пересборке перекрывает toggle
          // Кратко/Средне/Подробно (сервер сам решит длину по шаблону).
          length: processingTemplate ? undefined : summaryLength,
          instruction,
          processingTemplate,
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сделать протокол');
      }

      const patch = {
        summary: data.summary,
        tasks: data.tasks || [],
        ...(processingTemplate ? { processingTemplate } : null),
      };
      setSelectedRecording((current) => (current?.id === recording.id ? { ...current, ...patch } : current));
      setRecordings((current) => current.map((item) => (item.id === recording.id ? { ...item, ...patch } : item)));
      setStatus(`Протокол "${recording.title}" готов`);
    } catch (error) {
      setStatus(error.message || 'Ошибка создания протокола');
      throw error;
    } finally {
      setIsSummarizing(false);
    }
  }

  // #9: «удалить действие» — протокол и задачи стираются, стенограмма остаётся;
  // шаги «Протокол»/«Задачи» в мастере возвращаются в состояние «не сделано».
  async function handleDeleteSummary(recording) {
    if (!recording) {
      return;
    }

    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/summary`, { method: 'DELETE' });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось удалить протокол');
      }

      const patch = { summary: null, tasks: [] };
      setSelectedRecording((current) => (current?.id === recording.id ? { ...current, ...patch } : current));
      setRecordings((current) => current.map((item) => (item.id === recording.id ? { ...item, ...patch } : item)));
      setStatus('Протокол и задачи удалены');
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления протокола');
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

  async function handleRestore(recording) {
    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось восстановить');
      await loadRecordings();
      setStatus(`Запись "${recording.title}" восстановлена`);
    } catch (error) {
      setStatus(error.message || 'Ошибка восстановления');
    }
  }

  async function handlePurge(recording) {
    if (!window.confirm(`Удалить "${recording.title}" навсегда? Восстановить будет нельзя.`)) return;
    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/purge`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось удалить');
      await loadRecordings();
      setStatus('Запись удалена навсегда');
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления');
    }
  }

  async function handleUpdateProtection(recording, patch) {
    try {
      const response = await apiFetch(`/api/recordings/${recording.id}/protection`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось изменить защиту записи');
      }

      setSelectedRecording((current) => (current?.id === recording.id ? { ...current, ...data.recording } : current));
      setRecordings((current) => current.map((item) => (item.id === recording.id ? { ...item, ...data.recording } : item)));
      setStatus(patch.confidential !== undefined ? 'Метка конфиденциальности обновлена' : 'Настройка скачивания обновлена');
    } catch (error) {
      setStatus(error.message || 'Ошибка изменения защиты');
    }
  }

  async function handleCopyShareLink(url) {
    const copied = await copyText(url);
    setStatus(copied ? 'Ссылка скопирована' : 'Не удалось скопировать ссылку');
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

  // #3: групповое удаление — переиспользует одиночный DELETE (soft-delete → корзина),
  // но параллельно и с одним подтверждением на всю пачку вместо N диалогов.
  function toggleSelectionMode() {
    setSelectionMode((current) => !current);
    setSelectedIds(new Set());
  }

  function toggleRecordingSelected(recording) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(recording.id)) {
        next.delete(recording.id);
      } else {
        next.add(recording.id);
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    if (!selectedIds.size) {
      return;
    }

    const confirmed = window.confirm(`Удалить выбранные встречи (${selectedIds.size})? Они переместятся в корзину.`);

    if (!confirmed) {
      return;
    }

    setIsBulkDeleting(true);
    setStatus(`Удаляем ${selectedIds.size} встреч...`);

    try {
      const ids = [...selectedIds];
      await Promise.all(
        ids.map((id) => apiFetch(`/api/recordings/${id}`, { method: 'DELETE' }).catch(() => null)),
      );

      if (ids.includes(selectedRecordingId)) {
        setSelectedRecordingId(null);
        setSelectedRecording(null);
      }

      setSelectionMode(false);
      setSelectedIds(new Set());
      await loadRecordings(ids.includes(selectedRecordingId) ? null : selectedRecordingId);
      setStatus(`Удалено встреч: ${ids.length}`);
    } finally {
      setIsBulkDeleting(false);
    }
  }

  // Ссылка на результат (US-11.1) открывается внешним получателем без аккаунта,
  // поэтому проверяется до экрана входа. Роутера в проекте нет — страница
  // включается параметром ?share=<token>.
  if (shareToken) {
    return <SharePage token={shareToken} />;
  }

  if (isAuthLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <p className="eyebrow">Stenogram</p>
          <h1>Проверяем вход</h1>
        </section>
      </main>
    );
  }

  if (!currentUser && linkEmail) {
    const providerLabel =
      linkEmail.provider === 'telegram'
        ? 'Telegram'
        : oauthProviders.find((item) => item.provider === linkEmail.provider)?.label || '';

    return (
      <LinkEmailScreen
        providerLabel={providerLabel}
        onSubmit={handleCompleteOauth}
        isSubmitting={isAuthSubmitting}
        message={authMessage}
        needsPassword={linkEmailNeedsPassword}
      />
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
        registrationOpen={registrationEnabled}
        oauthProviders={oauthProviders}
        telegramLogin={telegramLogin}
      />
    );
  }

  return (
    <main
      className={`app-shell${isMobile && activePage === 'library' && selectedRecordingId ? ' app-shell--detail' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">Отпустите файл, чтобы загрузить запись</div>
        </div>
      ) : null}
      {consentPromptOpen ? (
        <ConsentDialog
          onProceed={() => {
            setConsentPromptOpen(false);
            handleMicRecordingToggle();
          }}
          onCancel={() => setConsentPromptOpen(false)}
        />
      ) : null}
      <Topbar
        activePage={activePage}
        isOnline={isOnline}
        isUploading={isUploading}
        isMicRecording={isMicRecording}
        handleFileChange={handleFileChange}
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
        onToggleRecording={startRecordingWithConsent}
        onTogglePause={handleMicPauseToggle}
        status={status}
      />

      {activePage === 'home' ? (
        <HomePage
          recordings={recordings}
          isLoading={isLoading}
          isMicRecording={isMicRecording}
          onStartRecording={startRecordingWithConsent}
          onOpenRecording={openRecordingFromAnywhere}
          setActivePage={setActivePage}
          hiddenBlocks={hiddenHomeBlocks}
          onToggleBlock={toggleHomeBlock}
          onUploadFile={(event) => {
            handleFileChange(event);
            setActivePage('library');
          }}
          meetingBotDraft={meetingBotDraft}
          setMeetingBotDraft={setMeetingBotDraft}
          onJoinMeeting={handleJoinMeeting}
          isJoiningMeeting={isJoiningMeeting}
        />
      ) : activePage === 'settings' ? (
        <SettingsPage settings={settings} micDeviceId={micDeviceId} setMicDeviceId={setMicDeviceId} status={status} currentUser={currentUser} onLoggedOut={handleLoggedOut} setStatus={setStatus} />
      ) : activePage === 'projects' ? (
        <>
          <section className="status-line" aria-live="polite">
            {status || `${projects.length} ${pluralizeRu(projects.length, ['проект', 'проекта', 'проектов'])}`}
          </section>
          <ProjectsPage projects={projects} projectsPage={projectsPage} onOpenRecording={openRecordingFromAnywhere} />
        </>
      ) : activePage === 'tasksearch' ? (
        <>
          <section className="status-line" aria-live="polite">
            {status}
          </section>
          <TaskSearchPage
            search={taskSearch}
            projectOptions={projectOptions}
            onOpenRecording={openRecordingFromAnywhere}
            onDictate={handleDictateVoiceNote}
            setStatus={setStatus}
          />
        </>
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
            filters={libraryFilters}
            setFilters={setLibraryFilters}
            onDictate={handleDictateVoiceNote}
            setStatus={setStatus}
            trashMode={trashMode}
            onToggleTrash={() => {
              setSelectedRecordingId(null);
              setTrashMode((v) => !v);
            }}
            sortOrder={sortOrder}
            onToggleSort={() => setSortOrder((v) => (v === 'asc' ? 'desc' : 'asc'))}
            selectionMode={selectionMode}
            onToggleSelectionMode={toggleSelectionMode}
          />

          <section className="status-line library-status" aria-live="polite">
            <span>{status || (hasRecordings ? `${recordings.length} ${pluralizeRu(recordings.length, ['встреча', 'встречи', 'встреч'])}${trashMode ? ' в корзине' : ''}` : trashMode ? 'Корзина пуста' : 'Встреч пока нет')}</span>
          </section>

          {/* #3: групповое удаление — панель появляется в режиме выбора. */}
          {selectionMode && !trashMode ? (
            <section className="sync-bar bulk-select-bar" aria-label="Групповые действия">
              <span className="sync-bar-count">Выбрано: <strong>{selectedIds.size}</strong></span>
              <div className="sync-bar-actions">
                <button
                  className="button button-danger"
                  type="button"
                  onClick={handleBulkDelete}
                  disabled={!selectedIds.size || isBulkDeleting}
                >
                  {isBulkDeleting ? 'Удаляем...' : 'Удалить выбранные'}
                </button>
              </div>
            </section>
          ) : null}

          {/* US-3.2/US-3.4: несинхронизированные записи + ручной запуск синхры и
              запрет выгрузки по мобильной сети. Панель видна, только когда есть
              что отправлять. */}
          {unsyncedCount > 0 && !trashMode ? (
            <section className="sync-bar" aria-label="Синхронизация">
              <span className="sync-bar-count">
                Несинхронизированных записей: <strong>{unsyncedCount}</strong>
              </span>
              <div className="sync-bar-actions">
                <label className="settings-toggle sync-bar-toggle">
                  <input
                    type="checkbox"
                    checked={blockMobileUpload}
                    onChange={(event) => setBlockMobileUpload(event.target.checked)}
                  />
                  Не выгружать по мобильной сети
                </label>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={handleManualSync}
                  disabled={isManualSyncing || !isOnline}
                >
                  {isManualSyncing ? 'Синхронизируем...' : 'Синхронизировать'}
                </button>
              </div>
            </section>
          ) : null}

          <section className="workspace" aria-label="Рабочая область записей">
            <section className="recording-list" aria-label="Список записей">
              {isLoading && !hasRecordings ? <div className="empty-state">Получаем список встреч...</div> : null}

              {!isLoading && !hasRecordings ? (
                <div className="empty-state">
                  {trashMode ? <h2>Корзина пуста</h2> : <><h2>Нет встреч</h2><p>Запишите первую встречу или добавьте аудиофайл.</p></>}
                </div>
              ) : null}

              {hasRecordings && trashMode ? (
                <div className="recording-cards trash-list">
                  {sortedRecordings.map((recording) => (
                    <article className="recording-card trash-card" key={recording.id}>
                      <div className="recording-card-main">
                        <strong className="recording-card-title">{recording.title || recording.originalFilename}</strong>
                        <span className="muted-text">удалено {formatDate(recording.deletedAt)} · будет стёрто через неделю</span>
                      </div>
                      <div className="trash-card-actions">
                        <button className="button button-secondary" type="button" onClick={() => handleRestore(recording)}>
                          Восстановить
                        </button>
                        <button className="button button-danger" type="button" onClick={() => handlePurge(recording)}>
                          Удалить навсегда
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}

              {hasRecordings && !trashMode ? (
                <div className="recording-cards">
                  {sortedRecordings.map((recording) => (
                    <RecordingCard
                      key={recording.id}
                      recording={recording}
                      isSelected={recording.id === selectedRecordingId}
                      onSelect={selectionMode ? () => toggleRecordingSelected(recording) : setSelectedRecordingId}
                      onDelete={handleDelete}
                      onProcess={handleProcess}
                      isDeleting={deletingId === recording.id}
                      enableSwipe={isMobile && !selectionMode}
                      selectionMode={selectionMode}
                      isChecked={selectedIds.has(recording.id)}
                      onToggleChecked={() => toggleRecordingSelected(recording)}
                    />
                  ))}
                </div>
              ) : null}
            </section>

            <aside className="detail-panel" aria-label="Детали записи">
              {/* US: на мобильном деталь открывается на весь экран — кнопка возврата к списку. */}
              {isMobile && selectedRecordingId ? (
                <button className="detail-back" type="button" onClick={() => setSelectedRecordingId(null)}>
                  К встречам
                </button>
              ) : null}

              {!selectedRecordingId ? (
                <div className="empty-state detail-empty">Выбери запись, чтобы увидеть детали.</div>
              ) : null}

              {selectedRecordingId && isDetailLoading ? <div className="empty-state detail-empty">Открываем запись...</div> : null}

              {selectedRecording && !isDetailLoading ? (
                <RecordingDetail
                  recording={selectedRecording}
                  onOpenSettings={() => setActivePage('settings')}
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
                  onDeleteSummary={handleDeleteSummary}
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
                  sending={sending}
                  sendConfig={sendConfig}
                  onCopyShareLink={handleCopyShareLink}
                  onUpdateProtection={handleUpdateProtection}
                  onUpdateTranscript={handleUpdateTranscript}
                  onUpdateProtocol={handleUpdateProtocol}
                  onDictate={handleDictateVoiceNote}
                  onAppendFragment={handleAppendFragment}
                  isAppendingFragment={isAppendingFragment}
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

      <BottomNav
        activePage={activePage}
        setActivePage={setActivePage}
        onRecordToggle={handleMicButtonClick}
        onPauseToggle={handleMicPauseToggle}
        isMicRecording={isMicRecording}
        isMicPaused={isMicPaused}
        canPauseMicRecording={canPauseMicRecording}
        micLevel={micLevel}
        micDuration={micDuration}
        isMicLevelLow={isMicLevelLow}
        isUploading={isUploading}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
      />
    </main>
  );
}

export default App;
