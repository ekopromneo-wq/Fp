const POLL_INTERVAL_MS = Number(process.env.END_DETECTION_POLL_MS || 3000);
// US-15.1 (a): разрыв WebRTC трактуется как ПАУЗА, а не конец встречи. Даём боту
// окно на переподключение (webrtcMonitor чистит rtcState при восстановлении) и
// завершаем только если связь не вернулась за это время. Раньше окно было 15с —
// коротко для реального переподключения, поэтому увеличено до 2 минут.
const RTC_RECONNECT_GRACE_MS = Number(process.env.END_DETECTION_RTC_RECONNECT_GRACE_MS || 120000);
const SILENCE_END_MS = Number(process.env.END_DETECTION_SILENCE_MS || 90000);
const MIN_CALL_DURATION_MS = Number(process.env.END_DETECTION_MIN_CALL_MS || 45000);
const MAX_MEETING_DURATION_MS = Number(process.env.END_DETECTION_MAX_MEETING_MS || 4 * 60 * 60 * 1000);

/**
 * Combines several independent signals to notice a meeting has ended,
 * without relying on any single fragile one:
 *  - manual stop request (signal.stopped)
 *  - the page closing/crashing
 *  - WebRTC peer connection going disconnected/failed/closed and staying
 *    that way (debounced, since brief network blips are common) - tracked in
 *    rtcState, which the caller must start populating via installWebrtcMonitor
 *    *before* the page navigates (see webrtcMonitor.js)
 *  - prolonged silence in the captured audio (ffmpeg's silencedetect), once
 *    the call has been running at least MIN_CALL_DURATION_MS
 *  - an optional platform-specific DOM check (adapter.matchesEndText)
 *  - a hard ceiling so a job can never run forever if every signal misses
 */
export async function waitForMeetingEnd({ page, signal, adapter, capture, rtcState }) {
  const joinedAt = Date.now();
  let silenceSince = null;

  const onFfmpegStderr = (chunk) => {
    const text = chunk.toString();

    if (/silence_start/.test(text)) {
      silenceSince = Date.now();
    } else if (/silence_end/.test(text)) {
      silenceSince = null;
    }
  };

  capture.process.stderr.on('data', onFfmpegStderr);

  try {
    return await new Promise((resolve) => {
      const hardTimeout = setTimeout(() => finish('max_duration_reached'), MAX_MEETING_DURATION_MS);
      let resolved = false;

      function finish(reason) {
        if (resolved) {
          return;
        }

        resolved = true;
        clearTimeout(hardTimeout);
        clearInterval(pollTimer);
        resolve(reason);
      }

      const pollTimer = setInterval(async () => {
        if (signal.stopped) {
          return finish('stopped');
        }

        if (page.isClosed()) {
          return finish('page_closed');
        }

        // US-15.1 (a): пока WebRTC в разрыве — это пауза с попыткой переподключения.
        // Не завершаем встречу и не считаем это «тишиной» (аудио молчит именно из-за
        // разрыва, а не потому, что встреча закончилась). Завершаем только если связь
        // не восстановилась за отведённое окно.
        if (rtcState.disconnectedSince) {
          silenceSince = null;

          if (Date.now() - rtcState.disconnectedSince > RTC_RECONNECT_GRACE_MS) {
            return finish('webrtc_reconnect_timeout');
          }

          return;
        }

        const callDurationMs = Date.now() - joinedAt;

        if (silenceSince && callDurationMs > MIN_CALL_DURATION_MS && Date.now() - silenceSince > SILENCE_END_MS) {
          return finish('prolonged_silence');
        }

        // US-15.1 (e): бота удалили из встречи — отдельная причина завершения,
        // проверяется раньше обычного «встреча завершена», чтобы различать их.
        if (adapter.matchesRemovedText) {
          const removed = await adapter.matchesRemovedText(page).catch(() => false);

          if (removed) {
            return finish('removed_from_meeting');
          }
        }

        if (adapter.matchesEndText) {
          const ended = await adapter.matchesEndText(page).catch(() => false);

          if (ended) {
            return finish('platform_end_text');
          }
        }
      }, POLL_INTERVAL_MS);
    });
  } finally {
    capture.process.stderr.off('data', onFfmpegStderr);
  }
}
