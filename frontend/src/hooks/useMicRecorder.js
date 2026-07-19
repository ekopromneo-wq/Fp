import { useEffect, useRef, useState } from 'react';
import useUiStore from '../store/uiStore.js';
import { startLiveRecordingSession, appendLiveRecordingChunk, clearLiveRecordingSession } from '../lib/offlineDb.js';

const LOW_LEVEL_THRESHOLD = 0.03;
const LOW_LEVEL_WARNING_MS = 4000;
// US-1.8: как часто MediaRecorder отдаёт готовый кусок, чтобы мы сбросили его в
// IndexedDB. При разряде теряется максимум последний неполный интервал.
const LIVE_CHUNK_INTERVAL_MS = 5000;

// US-1.1: короткий звуковой сигнал старта записи, по настройке пользователя.
// Отдельный одноразовый AudioContext (не тот, что у измерителя уровня) — играем
// в динамик, закрываем сразу после. Вызывается из обработчика клика, поэтому
// autoplay-политика браузера не мешает. Огибающая с плавным входом/выходом,
// чтобы тон не «щёлкал».
function playStartBeep() {
  if (!useUiStore.getState().startSoundEnabled) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  try {
    const ctx = new AudioContextClass();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + 0.16);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.18);
    oscillator.onended = () => ctx.close().catch(() => {});
  } catch {
    // Сигнал старта — необязательное украшение; запись работает и без него.
  }
}

export default function useMicRecorder(uploadRecordingFile, setStatus, micDeviceId) {
  const mediaRecorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const micChunksRef = useRef([]);
  const micStartedAtRef = useRef(null);
  const micAudioContextRef = useRef(null);
  const micAnalyserRef = useRef(null);
  const micLevelFrameRef = useRef(null);
  const micLevelPercentRef = useRef(0);
  const micDurationIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const micLowLevelSinceRef = useRef(null);
  const micLevelLowRef = useRef(false);
  const micSessionIdRef = useRef(null);

  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isMicPaused, setIsMicPaused] = useState(false);
  const [canPauseMicRecording, setCanPauseMicRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micDuration, setMicDuration] = useState(0);
  const [isMicLevelLow, setIsMicLevelLow] = useState(false);

  function runLevelMeterLoop(analyser) {
    const levelData = new Uint8Array(analyser.fftSize);

    const updateLevel = () => {
      analyser.getByteTimeDomainData(levelData);

      let sumSquares = 0;
      for (let i = 0; i < levelData.length; i += 1) {
        const normalized = (levelData[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }

      const rms = Math.sqrt(sumSquares / levelData.length);
      const percent = Math.round(Math.min(1, rms * 4) * 100);

      if (Math.abs(percent - micLevelPercentRef.current) >= 2) {
        micLevelPercentRef.current = percent;
        setMicLevel(percent / 100);
      }

      if (percent / 100 < LOW_LEVEL_THRESHOLD) {
        if (micLowLevelSinceRef.current === null) {
          micLowLevelSinceRef.current = performance.now();
        } else if (!micLevelLowRef.current && performance.now() - micLowLevelSinceRef.current >= LOW_LEVEL_WARNING_MS) {
          micLevelLowRef.current = true;
          setIsMicLevelLow(true);
        }
      } else {
        micLowLevelSinceRef.current = null;
        if (micLevelLowRef.current) {
          micLevelLowRef.current = false;
          setIsMicLevelLow(false);
        }
      }

      micLevelFrameRef.current = requestAnimationFrame(updateLevel);
    };

    micLevelFrameRef.current = requestAnimationFrame(updateLevel);
  }

  function resetLowLevelWarning() {
    micLowLevelSinceRef.current = null;
    micLevelLowRef.current = false;
    setIsMicLevelLow(false);
  }

  function pauseMicLevelMeter() {
    if (micLevelFrameRef.current !== null) {
      cancelAnimationFrame(micLevelFrameRef.current);
      micLevelFrameRef.current = null;
    }

    micLevelPercentRef.current = 0;
    setMicLevel(0);
    resetLowLevelWarning();
  }

  function resumeMicLevelMeter() {
    if (micAnalyserRef.current && micLevelFrameRef.current === null) {
      runLevelMeterLoop(micAnalyserRef.current);
    }
  }

  function stopMicLevelMeter() {
    pauseMicLevelMeter();
    micAnalyserRef.current = null;
    micAudioContextRef.current?.close().catch(() => {});
    micAudioContextRef.current = null;
  }

  function startMicLevelMeter(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      return;
    }

    try {
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      micAudioContextRef.current = audioContext;
      micAnalyserRef.current = analyser;

      runLevelMeterLoop(analyser);
    } catch {
      // Level meter is a visual enhancement only - recording keeps working without it.
    }
  }

  function stopDurationTimer() {
    if (micDurationIntervalRef.current !== null) {
      clearInterval(micDurationIntervalRef.current);
      micDurationIntervalRef.current = null;
    }
  }

  function runDurationTimer() {
    stopDurationTimer();
    micDurationIntervalRef.current = setInterval(() => {
      setMicDuration((value) => value + 1);
    }, 1000);
  }

  function startDurationTimer() {
    setMicDuration(0);
    runDurationTimer();
  }

  async function releaseWakeLock() {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;

    if (lock) {
      try {
        await lock.release();
      } catch {
        // Already released (e.g. the tab was hidden) - nothing to do.
      }
    }
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      return;
    }

    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
    } catch {
      // Wake lock is a best-effort enhancement - recording keeps working without it.
    }
  }

  function setMediaSessionState(playbackState) {
    if (!('mediaSession' in navigator)) {
      return;
    }

    try {
      if (playbackState === 'none') {
        navigator.mediaSession.metadata = null;
      } else if (typeof MediaMetadata !== 'undefined' && !navigator.mediaSession.metadata) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Идёт запись встречи',
          artist: 'Stenogram',
        });
      }

      navigator.mediaSession.playbackState = playbackState;
    } catch {
      // Media Session is a best-effort background-survival aid, not required for recording.
    }
  }

  function setMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) {
      return;
    }

    // 'stop' throws in some browsers that don't support it - set handlers independently.
    [
      ['pause', () => pauseMicRecording()],
      ['play', () => resumeMicRecording()],
      ['stop', () => stopMicRecording()],
    ].forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action on this browser - ignore.
      }
    });
  }

  function clearMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) {
      return;
    }

    ['pause', 'play', 'stop'].forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // Unsupported action on this browser - ignore.
      }
    });
  }

  async function startMicRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Запись с микрофона не поддерживается в этом браузере');
      return;
    }

    // US-17.1: заблаговременное предупреждение о нехватке места (если свободного
    // хватит меньше чем на ~15 минут записи). Оценка грубая — по typical-битрейту
    // ~1 МБ/мин; StorageManager есть не везде, поэтому проверка мягкая.
    try {
      if (navigator.storage?.estimate) {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        const freeBytes = Math.max(0, quota - usage);
        const minutesLeft = freeBytes / (1024 * 1024);

        if (quota > 0 && minutesLeft < 15) {
          const proceed = window.confirm(
            `На устройстве мало места — его хватит примерно на ${Math.max(1, Math.round(minutesLeft))} мин записи. Освободите место или продолжите на свой риск. Начать запись?`,
          );

          if (!proceed) {
            setStatus('Запись отменена — мало места на устройстве');
            return;
          }
        }
      }
    } catch {
      // Оценка места не критична — если недоступна, просто пишем без предупреждения.
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
        });
      } catch (deviceError) {
        if (micDeviceId && deviceError.name === 'OverconstrainedError') {
          // The saved device is no longer available (unplugged, etc.) - fall back
          // to the system default rather than failing to record altogether.
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw deviceError;
        }
      }

      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {};
      const recorder = new MediaRecorder(stream, options);

      micChunksRef.current = [];
      micStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      micStartedAtRef.current = new Date();

      // US-1.8: заводим сессию до старта рекордера, чтобы каждый чанк из
      // ondataavailable сразу оседал в IndexedDB. mimeType/имя фиксируем здесь —
      // при восстановлении файл собирается ровно с теми же параметрами.
      const mimeType = recorder.mimeType || options.mimeType || 'audio/webm';
      const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
      const filename = `mic-recording-${micStartedAtRef.current.toISOString().replace(/[:.]/g, '-')}.${extension}`;
      const sessionId = (crypto.randomUUID?.() || String(Date.now()));
      micSessionIdRef.current = sessionId;
      startLiveRecordingSession({ sessionId, mimeType, filename, source: 'frontend-microphone' }).catch(() => {});

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          micChunksRef.current.push(event.data);
          // Fire-and-forget: сбой записи в БД не должен прерывать саму запись.
          appendLiveRecordingChunk(sessionId, event.data).catch(() => {});
        }
      };

      recorder.onstop = async () => {
        const chunks = micChunksRef.current;

        stream.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
        mediaRecorderRef.current = null;
        micStartedAtRef.current = null;
        stopMicLevelMeter();
        stopDurationTimer();
        releaseWakeLock();
        clearMediaSessionHandlers();
        setMediaSessionState('none');
        setIsMicRecording(false);
        setIsMicPaused(false);

        if (!chunks.length) {
          // Ничего не записалось — восстанавливать нечего, чистим сессию.
          clearLiveRecordingSession().catch(() => {});
          micSessionIdRef.current = null;
          setStatus('Микрофонная запись пустая');
          return;
        }

        const file = new File([new Blob(chunks, { type: mimeType })], filename, { type: mimeType });
        micChunksRef.current = [];
        // Файл собран и уходит в очередь отправки — persisted-чанки больше не
        // нужны, иначе запись «восстановится» повторно при следующем запуске.
        await clearLiveRecordingSession().catch(() => {});
        micSessionIdRef.current = null;
        await uploadRecordingFile(file, 'frontend-microphone');
      };

      recorder.start(LIVE_CHUNK_INTERVAL_MS);
      playStartBeep();
      resetLowLevelWarning();
      startMicLevelMeter(stream);
      startDurationTimer();
      acquireWakeLock();
      setMediaSessionHandlers();
      setMediaSessionState('playing');
      setIsMicRecording(true);
      setIsMicPaused(false);
      setCanPauseMicRecording(typeof recorder.pause === 'function');
      setStatus('Идёт запись с микрофона...');
    } catch (error) {
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      mediaRecorderRef.current = null;
      stopMicLevelMeter();
      stopDurationTimer();
      releaseWakeLock();
      setIsMicRecording(false);
      setIsMicPaused(false);
      setStatus(error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : error.message || 'Не удалось начать запись');
    }
  }

  function pauseMicRecording() {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state !== 'recording' || typeof recorder.pause !== 'function') {
      return;
    }

    recorder.pause();
    stopDurationTimer();
    pauseMicLevelMeter();
    setMediaSessionState('paused');
    setIsMicPaused(true);
    setStatus('Запись на паузе');
  }

  function resumeMicRecording() {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state !== 'paused') {
      return;
    }

    recorder.resume();
    runDurationTimer();
    resumeMicLevelMeter();
    setMediaSessionState('playing');
    setIsMicPaused(false);
    setStatus('Идёт запись с микрофона...');
  }

  function handleMicPauseToggle() {
    if (isMicPaused) {
      resumeMicRecording();
      return;
    }

    pauseMicRecording();
  }

  function stopMicRecording() {
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      setStatus('Останавливаем запись...');
      recorder.stop();
      return;
    }

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    mediaRecorderRef.current = null;
    stopMicLevelMeter();
    stopDurationTimer();
    releaseWakeLock();
    clearMediaSessionHandlers();
    setMediaSessionState('none');
    setIsMicRecording(false);
    setIsMicPaused(false);
  }

  function handleMicRecordingToggle() {
    if (isMicRecording) {
      stopMicRecording();
      return;
    }

    startMicRecording();
  }

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;

      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }

      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      stopMicLevelMeter();
      stopDurationTimer();
      releaseWakeLock();
      clearMediaSessionHandlers();
    };
  }, []);

  // The Wake Lock is released automatically by the browser whenever the page
  // is hidden (spec behaviour, not something we can prevent) - re-request it
  // once the user comes back to the tab/app so the screen keeps staying on
  // for the rest of the recording.
  useEffect(() => {
    if (!isMicRecording) {
      return undefined;
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isMicRecording]);

  // Guard against the most common real way a recording actually gets lost in
  // a browser tab: an accidental close/refresh/navigation. We cannot stop the
  // OS from discarding a backgrounded tab under memory pressure, but we can
  // stop the user from doing it to themselves by mistake.
  useEffect(() => {
    if (!isMicRecording) {
      return undefined;
    }

    function handleBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isMicRecording]);

  return {
    isMicRecording,
    isMicPaused,
    canPauseMicRecording,
    micLevel,
    micDuration,
    isMicLevelLow,
    analyserRef: micAnalyserRef,
    startMicRecording,
    stopMicRecording,
    pauseMicRecording,
    resumeMicRecording,
    handleMicRecordingToggle,
    handleMicPauseToggle,
  };
}
