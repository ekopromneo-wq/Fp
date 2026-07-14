import { useEffect, useRef, useState } from 'react';

// No ASR/diarization provider used here exposes real transcription
// progress (see backend/src/worker.js) - this is a time-based estimate,
// not a true percentage, so it's deliberately capped below 100% until the
// status actually flips away from 'transcribing'.
const TRANSCRIBE_REAL_TIME_FACTOR = 0.3;

function TranscribingProgress({ recordingId, status, durationSeconds }) {
  const startRef = useRef(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (status !== 'transcribing') {
      startRef.current = null;
      return undefined;
    }

    if (startRef.current?.id !== recordingId) {
      startRef.current = { id: recordingId, startedAt: Date.now() };
    }

    const intervalId = window.setInterval(() => forceTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(intervalId);
  }, [status, recordingId]);

  if (status !== 'transcribing' || !startRef.current || !durationSeconds) {
    return null;
  }

  const elapsedMs = Date.now() - startRef.current.startedAt;
  const estimatedTotalMs = durationSeconds * TRANSCRIBE_REAL_TIME_FACTOR * 1000;
  const percent = Math.min(95, Math.round((elapsedMs / estimatedTotalMs) * 100));

  return (
    <span className="transcribe-progress" title="Оценка по длительности записи, не точный прогресс провайдера">
      ⏳ {percent}%
    </span>
  );
}

export default TranscribingProgress;
