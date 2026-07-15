import { useEffect, useState } from 'react';

// Уже запущено как установленное приложение (standalone-режим)?
function detectStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    window.matchMedia?.('(display-mode: minimal-ui)')?.matches ||
    window.navigator.standalone === true // iOS Safari
  );
}

// iOS/iPadOS не поддерживает beforeinstallprompt — установка только вручную
// через «Поделиться» → «На экран Домой». iPadOS 13+ маскируется под Mac,
// поэтому дополнительно проверяем тач.
function detectIos() {
  const ua = window.navigator.userAgent || '';
  const isAppleMobile = /iphone|ipad|ipod/i.test(ua);
  const isIpadOs = window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return (isAppleMobile || isIpadOs) && isSafari;
}

/**
 * Кнопка установки PWA: Chrome/Edge (Android и десктоп) присылают событие
 * `beforeinstallprompt`, которое нужно перехватить и вызвать по клику своей
 * кнопкой (авто-баннер Chrome давно убрал). iOS/Safari события не шлёт —
 * установка только вручную, поэтому там показываем инструкцию.
 */
export default function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(detectStandalone());

  useEffect(() => {
    function handleBeforeInstall(event) {
      event.preventDefault();
      setDeferredPrompt(event);
    }

    function handleInstalled() {
      setIsInstalled(true);
      setDeferredPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  async function promptInstall() {
    if (!deferredPrompt) {
      return null;
    }

    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice.catch(() => null);
    setDeferredPrompt(null);
    return choice?.outcome || null;
  }

  return {
    canInstall: Boolean(deferredPrompt),
    promptInstall,
    isInstalled,
    isIos: detectIos(),
  };
}
