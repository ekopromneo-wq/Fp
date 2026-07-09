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
