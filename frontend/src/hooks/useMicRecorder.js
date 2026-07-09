import { useEffect, useRef, useState } from 'react';

export default function useMicRecorder(uploadRecordingFile, setStatus) {
  const mediaRecorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const micChunksRef = useRef([]);
  const micStartedAtRef = useRef(null);
  const micAudioContextRef = useRef(null);
  const micAnalyserRef = useRef(null);
  const micLevelFrameRef = useRef(null);
  const micLevelPercentRef = useRef(0);

  const [isMicRecording, setIsMicRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  function stopMicLevelMeter() {
    if (micLevelFrameRef.current !== null) {
      cancelAnimationFrame(micLevelFrameRef.current);
      micLevelFrameRef.current = null;
    }

    micAnalyserRef.current = null;
    micAudioContextRef.current?.close().catch(() => {});
    micAudioContextRef.current = null;
    micLevelPercentRef.current = 0;
    setMicLevel(0);
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

        micLevelFrameRef.current = requestAnimationFrame(updateLevel);
      };

      micLevelFrameRef.current = requestAnimationFrame(updateLevel);
    } catch {
      // Level meter is a visual enhancement only - recording keeps working without it.
    }
  }

  async function startMicRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Запись с микрофона не поддерживается в этом браузере');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {};
      const recorder = new MediaRecorder(stream, options);

      micChunksRef.current = [];
      micStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      micStartedAtRef.current = new Date();

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          micChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const chunks = micChunksRef.current;
        const mimeType = recorder.mimeType || 'audio/webm';
        const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
        const startedAt = micStartedAtRef.current || new Date();
        const filename = `mic-recording-${startedAt.toISOString().replace(/[:.]/g, '-')}.${extension}`;

        stream.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
        mediaRecorderRef.current = null;
        micStartedAtRef.current = null;
        stopMicLevelMeter();
        setIsMicRecording(false);

        if (!chunks.length) {
          setStatus('Микрофонная запись пустая');
          return;
        }

        const file = new File([new Blob(chunks, { type: mimeType })], filename, { type: mimeType });
        micChunksRef.current = [];
        await uploadRecordingFile(file, 'frontend-microphone');
      };

      recorder.start();
      startMicLevelMeter(stream);
      setIsMicRecording(true);
      setStatus('Идёт запись с микрофона...');
    } catch (error) {
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      mediaRecorderRef.current = null;
      stopMicLevelMeter();
      setIsMicRecording(false);
      setStatus(error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : error.message || 'Не удалось начать запись');
    }
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
    setIsMicRecording(false);
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
    };
  }, []);

  return {
    isMicRecording,
    micLevel,
    analyserRef: micAnalyserRef,
    startMicRecording,
    stopMicRecording,
    handleMicRecordingToggle,
  };
}
