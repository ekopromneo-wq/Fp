import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const RECORDINGS_DIR = '/tmp/recordings';
const SINK_NAME = 'voxmate_sink';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

/**
 * Starts a single PulseAudio user daemon with a null sink for this
 * container and makes it the default sink, so any audio Chromium plays
 * (the call audio) is routed into a sink we can capture from instead of a
 * real output device. Meant to run once per container at startup.
 */
export async function initAudioSystem() {
  await mkdir(RECORDINGS_DIR, { recursive: true });

  await run('pulseaudio', ['-D', '--exit-idle-time=-1', '--disallow-exit']).catch((error) => {
    console.warn('pulseaudio start warning (may already be running):', error.message);
  });

  await run('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK_NAME}`]).catch((error) => {
    console.warn('null-sink load warning (may already exist):', error.message);
  });

  await run('pactl', ['set-default-sink', SINK_NAME]);

  console.log('Audio system ready: pulseaudio + null sink', SINK_NAME);
}

/**
 * Starts recording the null sink's monitor to a wav file for one job. Also
 * runs ffmpeg's silencedetect filter on the same stream so callers can watch
 * stderr for "silence_start"/"silence_end" markers - one of the signals used
 * to notice a call has ended (see endDetection.js).
 * Returns a stop() that finalizes the file and resolves once ffmpeg exits.
 */
export function startCapture(jobId) {
  const filePath = `${RECORDINGS_DIR}/${jobId}.wav`;

  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'pulse',
    '-i', `${SINK_NAME}.monitor`,
    '-ac', '1',
    '-ar', '16000',
    '-af', 'silencedetect=noise=-30dB:d=2',
    filePath,
  ]);

  const exited = new Promise((resolve) => {
    ffmpeg.on('exit', () => resolve());
  });

  return {
    filePath,
    process: ffmpeg,
    async stop() {
      ffmpeg.kill('SIGINT');
      await exited;
    },
  };
}
