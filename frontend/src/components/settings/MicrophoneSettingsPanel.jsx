import { useEffect, useRef, useState } from 'react';
import useUiStore from '../../store/uiStore.js';

export default function MicrophoneSettingsPanel({ micDeviceId, setMicDeviceId }) {
  const startSoundEnabled = useUiStore((state) => state.startSoundEnabled);
  const setStartSoundEnabled = useUiStore((state) => state.setStartSoundEnabled);
  const storageMode = useUiStore((state) => state.storageMode);
  const setStorageMode = useUiStore((state) => state.setStorageMode);
  const [devices, setDevices] = useState([]);
  const [isTesting, setIsTesting] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const [testError, setTestError] = useState('');

  const testStreamRef = useRef(null);
  const testAudioContextRef = useRef(null);
  const testFrameRef = useRef(null);

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((device) => device.kind === 'audioinput'));
  }

  useEffect(() => {
    refreshDevices();

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    }

    return undefined;
  }, []);

  function stopTest() {
    if (testFrameRef.current !== null) {
      cancelAnimationFrame(testFrameRef.current);
      testFrameRef.current = null;
    }

    testStreamRef.current?.getTracks().forEach((track) => track.stop());
    testStreamRef.current = null;
    testAudioContextRef.current?.close().catch(() => {});
    testAudioContextRef.current = null;
    setIsTesting(false);
    setTestLevel(0);
  }

  async function startTest() {
    setTestError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setTestError('Тест микрофона не поддерживается в этом браузере');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      });
      testStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      testAudioContextRef.current = audioContext;

      const data = new Uint8Array(analyser.fftSize);

      const tick = () => {
        analyser.getByteTimeDomainData(data);

        let sumSquares = 0;
        for (let i = 0; i < data.length; i += 1) {
          const normalized = (data[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / data.length);
        setTestLevel(Math.min(1, rms * 4));
        testFrameRef.current = requestAnimationFrame(tick);
      };

      testFrameRef.current = requestAnimationFrame(tick);
      setIsTesting(true);

      // Device labels are blank until permission has been granted at least
      // once - refresh so the dropdown can show real names from now on.
      await refreshDevices();
    } catch (error) {
      setTestError(error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : error.message || 'Не удалось получить доступ к микрофону');
    }
  }

  useEffect(() => () => stopTest(), []);

  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Запись</p>
          <h2>Микрофон</h2>
        </div>
      </div>

      <div className="settings-form">
        <label>
          Устройство записи
          <select value={micDeviceId} onChange={(event) => setMicDeviceId(event.target.value)}>
            <option value="">Микрофон по умолчанию</option>
            {devices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Микрофон ${index + 1}`}
              </option>
            ))}
          </select>
        </label>

        <div className="mic-test-row">
          <button className="button button-secondary" type="button" onClick={isTesting ? stopTest : startTest}>
            {isTesting ? 'Остановить тест' : 'Тест микрофона'}
          </button>

          {isTesting ? (
            <div className="mic-test-meter" role="meter" aria-label="Уровень сигнала микрофона" aria-valuenow={Math.round(testLevel * 100)} aria-valuemin="0" aria-valuemax="100">
              <div className="mic-test-meter-fill" style={{ width: `${testLevel * 100}%` }} />
            </div>
          ) : null}
        </div>

        {testError ? <p className="settings-note mic-test-error">{testError}</p> : null}

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={startSoundEnabled}
            onChange={(event) => setStartSoundEnabled(event.target.checked)}
          />
          Звуковой сигнал в начале записи
        </label>

        {/* US-3.5: где хранить новые записи. По умолчанию — облако. */}
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={storageMode === 'device'}
            onChange={(event) => setStorageMode(event.target.checked ? 'device' : 'cloud')}
          />
          Хранить новые записи только на устройстве
        </label>

        {storageMode === 'device' ? (
          <p className="settings-note critical-failure-banner">
            Записи не выгружаются в облако: не будет расшифровки, протокола и задач, они не появятся
            на других устройствах. Аудио шифруется на устройстве, но при удалении приложения — теряется.
          </p>
        ) : null}
      </div>

      <p className="settings-note">
        Названия устройств появятся после того, как браузер даст доступ к микрофону — например, после первого теста
        или записи. Выбор запоминается на этом устройстве и применяется ко всем следующим записям.
      </p>
    </section>
  );
}
