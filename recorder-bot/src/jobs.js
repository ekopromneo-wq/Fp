import { chromium } from 'playwright';
import { startCapture } from './audioCapture.js';
import { getPlatformAdapter } from './platforms/index.js';
import { sendCallback } from './callback.js';
import { waitForMeetingEnd } from './endDetection.js';
import { installWebrtcMonitor } from './webrtcMonitor.js';

// Phase 1 scope: one recording at a time per container instance. Scale by
// running additional recorder-bot replicas if concurrent meetings are needed.
let currentJob = null;

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
  currentJob = { jobId, recordingId, signal, status: 'starting' };

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

  try {
    currentJob.status = 'joining';
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
    const page = await context.newPage();

    // Must be installed before the page navigates (adapter.join), since it
    // patches window.RTCPeerConnection via an init script.
    const rtcState = { disconnectedSince: null };

    await installWebrtcMonitor(page, (state) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        rtcState.disconnectedSince ||= Date.now();
      } else {
        rtcState.disconnectedSince = null;
      }
    }).catch((error) => {
      console.warn(`[job ${jobId}] webrtc monitor install failed (continuing without it):`, error.message);
    });

    capture = startCapture(jobId);
    currentJob.status = 'recording';

    await adapter.join({ page, meetingUrl, botName });

    const reason = await waitForMeetingEnd({ page, signal, adapter, capture, rtcState });
    console.log(`[job ${jobId}] ending (${reason})`);

    await capture.stop();
    await browser.close();
    browser = null;

    await sendCallback({ recordingId, filePath: capture.filePath });
    currentJob = currentJob && currentJob.jobId === jobId ? null : currentJob;
  } catch (error) {
    console.error(`[job ${jobId}] error:`, error);

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
