import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const RECORDINGS_DIR = '/tmp/recordings';
const SINK_NAME = 'voxmate_sink';
// STG-036: путь фейкового аудио-файла для --use-file-for-fake-audio-capture
// (см. initAudioSystem/jobs.js) — без него Chromium's fake audio device
// генерирует синтетический тестовый тон вместо тишины.
export const FAKE_AUDIO_FILE = '/tmp/voxmate-silence.wav';
// STG-036: то же самое для видео - без файла фейковая камера Chromium
// показывает анимированный тестовый паттерн (движущийся прямоугольник),
// который участники встречи видели вместо бота и не понимали, что это.
export const FAKE_VIDEO_FILE = '/tmp/voxmate-placeholder.y4m';
const PLACEHOLDER_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

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

  // STG-036: без --use-file-for-fake-audio-capture Chromium's fake mic (мы
  // включаем --use-fake-device-for-media-stream, чтобы getUserMedia не
  // спотыкался о permission prompt) отдаёт синтетический тестовый тон -
  // именно его слышали участники встречи как "продолжительный пищащий
  // сигнал". Готовим 10с тишины один раз при старте контейнера, Chromium
  // зацикливает файл на всю длительность звонка.
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '10', FAKE_AUDIO_FILE]);

  // STG-036: аналогично для видео - статичная заставка вместо анимированного
  // тестового паттерна фейковой камеры Chromium.
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1a2332:s=640x480:d=5:r=30,drawtext=fontfile=${PLACEHOLDER_FONT}:text='Stenogram — идёт запись':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-pix_fmt',
    'yuv420p',
    FAKE_VIDEO_FILE,
  ]).catch((error) => {
    // Заставка не критична для самой записи - если шрифт/фильтр вдруг
    // недоступны в образе, лучше вернуться к тестовому паттерну Chromium
    // (--use-file-for-fake-video-capture просто не сработает), чем уронить
    // старт контейнера из-за декоративной детали.
    console.warn('fake video placeholder generation failed (falling back to Chromium default):', error.message);
  });

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
