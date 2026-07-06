import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv']);

/**
 * The diarization/ASR pipeline is audio-only, and several of its paths
 * (Shopot, plain OpenRouter ASR for small files) send the raw buffer to their
 * APIs as-is with no ffmpeg step - that doesn't reliably work against a raw
 * video container. Video uploads need their audio track extracted once,
 * up front, rather than teaching every diarization method about video.
 */
export function isVideoContainer(file) {
  const mimeType = file?.mime_type || '';

  if (mimeType.startsWith('video/')) {
    return true;
  }

  const filename = file?.original_filename || '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  return VIDEO_EXTENSIONS.has(extension);
}

function getInputExtension(file) {
  const filename = file?.original_filename || '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  return extension || 'mp4';
}

function runFfmpeg(args) {
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
 * Strips the video stream from an uploaded video file, leaving just its
 * audio track (mono, 16kHz, matching the same target used elsewhere in the
 * pipeline for ASR/diarization - speech transcription doesn't need more).
 */
export async function extractAudioTrack(file, videoBuffer) {
  const workdir = path.join(tmpdir(), `voxmate-video-${randomUUID()}`);
  const inputPath = path.join(workdir, `input.${getInputExtension(file)}`);
  const outputPath = path.join(workdir, 'audio.mp3');

  await mkdir(workdir, { recursive: true });

  try {
    await writeFile(inputPath, videoBuffer);
    await runFfmpeg(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '128k', outputPath]);

    const buffer = await readFile(outputPath);
    console.log(
      `Extracted audio track from ${file?.original_filename || 'video upload'}: ${videoBuffer.length} -> ${buffer.length} bytes`,
    );

    const baseName = (file?.original_filename || 'audio').replace(/\.[^./]+$/, '');

    return {
      buffer,
      originalFilename: `${baseName}.mp3`,
      mimeType: 'audio/mpeg',
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
