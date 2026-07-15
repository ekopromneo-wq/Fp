import { useState } from 'react';
import useInstallPrompt from '../hooks/useInstallPrompt.js';

function DownloadGlyph() {
  return (
    <svg className="icon-button-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}

/**
 * Affordance установки PWA. Chrome/Edge — кнопка «Установить приложение»
 * (появляется только когда браузер прислал beforeinstallprompt, т.е. критерии
 * установки выполнены). iOS/Safari — кнопка-подсказка с ручной инструкцией.
 * Если приложение уже установлено (standalone) или установка недоступна —
 * не рендерит ничего. `variant='compact'` — иконка для топбара.
 */
export default function InstallButton({ variant = 'full' }) {
  const { canInstall, promptInstall, isInstalled, isIos } = useInstallPrompt();
  const [showIosHint, setShowIosHint] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (canInstall) {
    if (variant === 'compact') {
      return (
        <button
          className="button icon-button button-secondary"
          type="button"
          onClick={promptInstall}
          aria-label="Установить приложение"
          title="Установить приложение"
        >
          <DownloadGlyph />
        </button>
      );
    }

    return (
      <button className="button button-secondary install-button" type="button" onClick={promptInstall}>
        <DownloadGlyph />
        Установить приложение
      </button>
    );
  }

  if (isIos) {
    if (variant === 'compact') {
      return (
        <button
          className="button icon-button button-secondary"
          type="button"
          onClick={() => setShowIosHint((v) => !v)}
          aria-label="Как установить на iPhone/iPad"
          title="Как установить на iPhone/iPad"
        >
          <DownloadGlyph />
        </button>
      );
    }

    return (
      <div className="install-ios">
        <button className="button button-secondary install-button" type="button" onClick={() => setShowIosHint((v) => !v)}>
          <DownloadGlyph />
          Установить на iPhone/iPad
        </button>
        {showIosHint ? (
          <p className="install-ios-hint">
            В Safari нажмите «Поделиться» (квадрат со стрелкой вверх) → «На экран «Домой»».
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}
