import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import useUiStore from '../store/uiStore.js';
import { fetchAppRuntime, CLIENT_OUTDATED_EVENT, buildVersion } from '../lib/api.js';
import { hardResetServiceWorker } from '../lib/pwa.js';

// ADR-035: обновление PWA без залипания старой сборки.
//  §4.3 — новая версия встаёт в waiting, показываем ненавязчивый баннер
//         «Доступна новая версия»; применяем по нажатию (skipWaiting + reload
//         через updateSW(true)); во время активной записи откладываем.
//  §4.4 — сервер на 426 (client_outdated) поднимает событие CLIENT_OUTDATED_EVENT,
//         минимальную версию также сверяем на загрузке через /api/app/runtime.
//  §4.5 — kill-switch: при killSwitch=true делаем hardResetServiceWorker().

// SPA живёт в одной вкладке долго — периодически спрашиваем SW про новый билд.
const UPDATE_POLL_MS = 60 * 60 * 1000;

export default function PwaUpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [applying, setApplying] = useState(false);
  const isRecordingActive = useUiStore((state) => state.isRecordingActive);

  const updateSWRef = useRef(null);
  // Пользователь нажал «Обновить», но идёт запись — ждём её завершения (§4.3).
  const pendingApplyRef = useRef(false);
  const [deferredByRecording, setDeferredByRecording] = useState(false);

  // Регистрация Service Worker (injectRegister отключён в vite.config.js, делаем
  // это сами, чтобы владеть моментом применения). registerSW идемпотентен, но
  // страхуемся ref-ом от повторного вызова в StrictMode.
  useEffect(() => {
    if (updateSWRef.current) {
      return;
    }

    updateSWRef.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onRegisteredSW(_swUrl, registration) {
        if (!registration) {
          return;
        }

        setInterval(() => {
          registration.update().catch(() => {});
        }, UPDATE_POLL_MS);
      },
    });
  }, []);

  // Kill-switch и сверка минимальной версии контракта на загрузке (§4.4/§4.5).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const runtime = await fetchAppRuntime();

      if (cancelled || !runtime) {
        return;
      }

      if (runtime.killSwitch) {
        await hardResetServiceWorker();
        return;
      }

      if (runtime.minClientVersion && Number(buildVersion) < runtime.minClientVersion) {
        setNeedRefresh(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Сервер ответил 426 на каком-либо запросе — форсим баннер (§4.4).
  useEffect(() => {
    function handleOutdated() {
      setNeedRefresh(true);
    }

    window.addEventListener(CLIENT_OUTDATED_EVENT, handleOutdated);
    return () => window.removeEventListener(CLIENT_OUTDATED_EVENT, handleOutdated);
  }, []);

  async function applyUpdate() {
    setApplying(true);

    const updateSW = updateSWRef.current;

    if (updateSW) {
      // updateSW(true): skipWaiting у ожидающего SW + перезагрузка страницы.
      await updateSW(true);
    } else {
      // Нет ожидающего SW (баннер поднят 426/минимальной версией) — просто
      // перезагружаемся, чтобы подтянуть свежую оболочку.
      window.location.reload();
    }
  }

  // Запись закончилась, а обновление было отложено — применяем (§4.3).
  useEffect(() => {
    if (!isRecordingActive && pendingApplyRef.current) {
      pendingApplyRef.current = false;
      setDeferredByRecording(false);
      applyUpdate();
    }
  }, [isRecordingActive]);

  function handleUpdateClick() {
    if (isRecordingActive) {
      pendingApplyRef.current = true;
      setDeferredByRecording(true);
      return;
    }

    applyUpdate();
  }

  if (!needRefresh) {
    return null;
  }

  return (
    <div className="pwa-update-banner" role="status" aria-live="polite">
      <span className="pwa-update-banner__text">
        {deferredByRecording ? 'Обновление применится после записи' : 'Доступна новая версия'}
      </span>
      <button
        type="button"
        className="pwa-update-banner__button"
        onClick={handleUpdateClick}
        disabled={applying || deferredByRecording}
      >
        {applying ? 'Обновляем…' : deferredByRecording ? 'Ждём…' : 'Обновить'}
      </button>
    </div>
  );
}
