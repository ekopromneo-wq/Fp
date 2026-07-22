import { spawn } from 'node:child_process';

export function getAudioFormat(file) {
  const filename = file?.original_filename || '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  if (extension) {
    return extension === 'mpeg' ? 'mp3' : extension;
  }

  if (file?.mime_type?.includes('/')) {
    return file.mime_type.split('/').pop().toLowerCase();
  }

  return 'mp3';
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

/**
 * US-1.5: склеивает несколько аудиофайлов (возможно разных форматов) в один.
 * Через concat-фильтр с полным перекодированием в MP3 — единственный надёжный
 * путь для разнородных кодеков (webm/opus запись + загруженный mp3/m4a/wav):
 * простая склейка контейнеров на разных кодеках даёт битый файл. MP3 на выходе
 * принимает и ASR-пайплайн (getAudioFormat → mp3 по умолчанию).
 */
export function concatAudioFiles(inputPaths, outputPath) {
  if (!inputPaths?.length) {
    return Promise.reject(new Error('concatAudioFiles: no input files'));
  }

  const inputArgs = inputPaths.flatMap((filePath) => ['-i', filePath]);
  const filterInputs = inputPaths.map((_, index) => `[${index}:a]`).join('');
  const filter = `${filterInputs}concat=n=${inputPaths.length}:v=0:a=1[out]`;

  return runFfmpeg([
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '4',
    outputPath,
  ]);
}

// Длительность через полный декод: `ffmpeg -i file -f null -` пишет прогресс
// «time=HH:MM:SS.xx» в stderr — берём последний. Нужен для потоковых контейнеров
// (webm из MediaRecorder), у которых в заголовке duration=N/A: файл валиден,
// но format=duration его не отдаёт. Opus/webm декодируется в десятки раз
// быстрее реального времени, поэтому фолбэк дешёвый.
function measureDurationByDecodeSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'info', '-i', filePath, '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrTail = '';

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-8192);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const matches = [...stderrTail.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];

      if (code === 0 && matches.length) {
        const last = matches[matches.length - 1];
        resolve(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
        return;
      }

      reject(new Error(`ffmpeg decode-duration failed with code ${code}: ${stderrTail.slice(-500)}`));
    });
  });
}

/**
 * Reads a media file's duration via ffprobe. A failure here (non-zero exit,
 * unparseable output) is also the cheapest reliable "is this file actually a
 * readable media file" check available - callers use it to detect corrupt or
 * unsupported uploads, not just to get a number.
 *
 * Потоковый webm из MediaRecorder (микрофонные записи, US-1.8 timeslice) не
 * содержит duration в заголовке — ffprobe выходит с кодом 0 и «N/A». Такой файл
 * НЕ битый: длительность добираем декодом (см. measureDurationByDecodeSeconds),
 * а браковка остаётся только для настоящих ошибок чтения.
 */
export function getFfprobeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const seconds = parseFloat(stdout.trim());

      if (code === 0 && Number.isFinite(seconds)) {
        resolve(seconds);
        return;
      }

      if (code === 0) {
        // Контейнер читается, но длительности в заголовке нет — меряем декодом.
        measureDurationByDecodeSeconds(filePath).then(resolve, reject);
        return;
      }

      reject(new Error(`ffprobe failed with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}
