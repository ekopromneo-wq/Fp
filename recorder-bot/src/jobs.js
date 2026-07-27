import { chromium } from 'playwright';
import { startCapture } from './audioCapture.js';
import { getPlatformAdapter } from './platforms/index.js';
import { sendCallback, sendEvent } from './callback.js';
import { waitForMeetingEnd } from './endDetection.js';
import { installWebrtcMonitor } from './webrtcMonitor.js';

// Phase 1 scope: one recording at a time per container instance. Scale by
// running additional recorder-bot replicas if concurrent meetings are needed.
let currentJob = null;

// STG-001: join-фаза (launch браузера + вход в конференцию) раньше не была
// ничем ограничена по времени - зависший Playwright/сеть навсегда занимал
// currentJob, и КАЖДОЕ следующее приглашение (любой пользователь, любая
// встреча) получало 409 без объяснения. JOIN_PHASE_TIMEOUT_MS гарантирует,
// что join либо завершится, либо упадёт в разумный срок и currentJob
// освободится через обычный catch/finally в runJob.
const JOIN_PHASE_TIMEOUT_MS = Number(process.env.RECORDER_BOT_JOIN_TIMEOUT_MS || 90000);

// Второй, защитный слой: если что-то умудрится зависнуть ДО того, как
// Promise.race успевает сработать (например, сам chromium.launch не
// отклоняет и не резолвит промис из-за повреждённого процесса), watchdog
// принудительно освобождает застрявшую блокировку. Не трогает фазу
// 'recording' - там уже есть свой потолок (END_DETECTION_MAX_MEETING_MS).
const WATCHDOG_INTERVAL_MS = 30000;
const PRE_RECORDING_MAX_AGE_MS = 2 * 60000;

setInterval(() => {
  if (currentJob && (currentJob.status === 'starting' || currentJob.status === 'joining')) {
    const age = Date.now() - currentJob.startedAt;
    if (age > PRE_RECORDING_MAX_AGE_MS) {
      console.error(
        `[watchdog] force-clearing wedged job ${currentJob.jobId} (age ${age}ms, phase ${currentJob.status})`,
      );
      currentJob = null;
    }
  }
}, WATCHDOG_INTERVAL_MS);

// US-15.1: текст объявления о записи, которое бот пишет в чат встречи.
const RECORDING_NOTICE =
  process.env.RECORDING_NOTICE ||
  'Идёт запись и стенографирование встречи (Бот-ассистент). Итоги и задачи получит организатор.';

export function getCurrentJob() {
  return currentJob;
}

export async function createJob({ recordingId, meetingUrl, title, platform, botName }) {
  if (currentJob) {
    throw new Error('Another recording is already in progress on this recorder-bot instance');
  }

  const adapter = getPlatformAdapter(platform);

  if (!adapter) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const jobId = recordingId;
  const signal = { stopped: false };
  currentJob = { jobId, recordingId, signal, status: 'starting', startedAt: Date.now() };

  runJob({ jobId, recordingId, meetingUrl, botName, adapter, signal }).catch((error) => {
    console.error(`[job ${jobId}] unhandled failure:`, error);
  });

  return { jobId };
}

export function stopJob(jobId) {
  if (!currentJob || currentJob.jobId !== jobId) {
    return false;
  }

  currentJob.signal.stopped = true;

  return true;
}

async function runJob({ jobId, recordingId, meetingUrl, botName, adapter, signal }) {
  let browser = null;
  let capture = null;
  let page = null;
  let rtcState;

  // US-15.1: отчёт о событии подключения в журнал бэкенда (fire-and-forget).
  const report = (event, detail = {}) =>
    sendEvent({ recordingId, event, detail }).catch((error) =>
      console.warn(`[job ${jobId}] event report "${event}" failed:`, error.message),
    );

  try {
    currentJob.status = 'joining';
    report('joining');

    // STG-001(b): launch+join не был ничем ограничен по времени - вешаем
    // жёсткий потолок, чтобы зависший Playwright/сеть не занимали
    // currentJob навсегда (см. комментарий у JOIN_PHASE_TIMEOUT_MS выше).
    // browser/capture/rtcState присваиваются во внешние переменные (не
    // передекларируются), чтобы catch-блок ниже мог их корректно закрыть.
    await Promise.race([
      (async () => {
        browser = await chromium.launch({
          // Playwright mutes audio by default (--mute-audio) to keep CI runs
          // quiet - we need real call audio to reach our PulseAudio sink, so it
          // must be explicitly un-muted.
          ignoreDefaultArgs: ['--mute-audio'],
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        });
        const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
        page = await context.newPage();

        // Must be installed before the page navigates (adapter.join), since it
        // patches window.RTCPeerConnection via an init script.
        rtcState = { disconnectedSince: null };

        await installWebrtcMonitor(page, (state) => {
          if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            // Первый переход в разрыв — фиксируем событие (не спамим на каждый тик).
            if (!rtcState.disconnectedSince) {
              report('rtc_disconnected', { state });
            }
            rtcState.disconnectedSince ||= Date.now();
          } else {
            // Восстановление после ранее зафиксированного разрыва.
            if (rtcState.disconnectedSince) {
              report('rtc_reconnected', { state });
            }
            rtcState.disconnectedSince = null;
          }
        }).catch((error) => {
          console.warn(`[job ${jobId}] webrtc monitor install failed (continuing without it):`, error.message);
        });

        capture = startCapture(jobId);
        currentJob.status = 'recording';

        await adapter.join({ page, meetingUrl, botName });
        // Вошёл в конференцию, идёт запись.
        report('in_meeting');

        // US-15.1: бот объявляет о записи в чате встречи (best-effort). Даже если
        // сообщение отправить не удалось (чат недоступен/сменились селекторы) — запись
        // продолжается, а факт попытки фиксируется в журнале подключений.
        if (typeof adapter.announce === 'function') {
          const announced = await adapter
            .announce({ page, message: RECORDING_NOTICE })
            .catch(() => false);
          report('recording_announced', { via: 'chat', ok: !!announced });
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Join phase exceeded ${JOIN_PHASE_TIMEOUT_MS}ms`)), JOIN_PHASE_TIMEOUT_MS),
      ),
    ]);

    const reason = await waitForMeetingEnd({ page, signal, adapter, capture, rtcState });
    console.log(`[job ${jobId}] ending (${reason})`);
    // US-15.1 (a): встреча завершилась из-за того, что WebRTC не переподключился
    // за отведённое окно — отдельное событие журнала, отличное от штатного конца.
    if (reason === 'webrtc_reconnect_timeout') {
      report('rtc_reconnect_timeout');
    }
    // US-15.1 (e): бота удалили из встречи — событие журнала триггерит уведомление
    // владельцу на стороне бэкенда. Отправляем до финального callback с (частичным) аудио.
    if (reason === 'removed_from_meeting') {
      report('removed');
    }
    report('ended', { reason });

    await capture.stop();
    await browser.close();
    browser = null;

    await sendCallback({ recordingId, filePath: capture.filePath });
    currentJob = currentJob && currentJob.jobId === jobId ? null : currentJob;
  } catch (error) {
    console.error(`[job ${jobId}] error:`, error);
    report('ended_error', { error: error.message });

    if (capture) {
      await capture.stop().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    await sendCallback({ recordingId, errorMessage: error.message }).catch((callbackError) => {
      console.error(`[job ${jobId}] callback failed:`, callbackError);
    });
  } finally {
    if (currentJob && currentJob.jobId === jobId) {
      currentJob = null;
    }
  }
}
