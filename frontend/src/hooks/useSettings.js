import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

/**
 * Owns every settings panel's draft state and its load/save round-trips
 * (SMTP, Telegram, Bitrix24, diarization, notifications, sending). Extracted
 * verbatim from App.jsx - the couplings back to the app are setStatus for the
 * shared status line and onSendConfigSaved, which lets the send panel pick up
 * new defaults without a reload.
 */
export default function useSettings(setStatus, onSendConfigSaved) {
  const [smtpDraft, setSmtpDraft] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '' });
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [telegramSettingsDraft, setTelegramSettingsDraft] = useState({ chatId: '', botToken: '' });
  const [telegramHasToken, setTelegramHasToken] = useState(false);
  const [isSavingTelegramSettings, setIsSavingTelegramSettings] = useState(false);
  const [bitrixSettingsDraft, setBitrixSettingsDraft] = useState({ webhookUrl: '', defaultResponsibleId: '', defaultGroupId: '' });
  const [bitrixHasWebhook, setBitrixHasWebhook] = useState(false);
  const [isSavingBitrixSettings, setIsSavingBitrixSettings] = useState(false);
  const [diarizationSettingsDraft, setDiarizationSettingsDraft] = useState({
    method: 'shopot',
    shopotApiKey: '',
    geminiModel: 'google/gemini-2.5-pro',
    speech2textApiKey: '',
    kimiModel: 'moonshotai/kimi-k2.6',
    language: '',
  });
  const [diarizationHasShopotKey, setDiarizationHasShopotKey] = useState(false);
  const [diarizationHasSpeech2textKey, setDiarizationHasSpeech2textKey] = useState(false);
  const [isSavingDiarizationSettings, setIsSavingDiarizationSettings] = useState(false);
  const [notificationSettingsDraft, setNotificationSettingsDraft] = useState({ channels: ['in_app', 'email'], dnd: false });
  const [isSavingNotificationSettings, setIsSavingNotificationSettings] = useState(false);
  const [sendSettingsDraft, setSendSettingsDraft] = useState({ preview: true, defaultChannel: 'email', attachDocx: true });
  const [isSavingSendSettings, setIsSavingSendSettings] = useState(false);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  async function loadSmtpSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/smtp');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки SMTP');
      }

      setSmtpDraft({
        host: data.smtp?.host || '',
        port: String(data.smtp?.port || 587),
        secure: Boolean(data.smtp?.secure),
        user: data.smtp?.user || '',
        pass: '',
        from: data.smtp?.from || '',
      });
      setSmtpHasPassword(Boolean(data.smtp?.hasPassword));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек SMTP');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveSmtpSettings(event) {
    event.preventDefault();
    setIsSavingSettings(true);
    setStatus('Сохраняем SMTP-настройки...');

    try {
      const response = await apiFetch('/api/settings/smtp', {
        method: 'PATCH',
        body: JSON.stringify({
          ...smtpDraft,
          port: Number(smtpDraft.port || 587),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить SMTP-настройки');
      }

      setSmtpDraft((current) => ({ ...current, pass: '' }));
      setSmtpHasPassword(Boolean(data.smtp?.hasPassword));
      setStatus('SMTP-настройки сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения SMTP-настроек');
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function loadTelegramSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/telegram');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки Telegram');
      }

      setTelegramSettingsDraft({ chatId: data.telegram?.chatId || '', botToken: '' });
      setTelegramHasToken(Boolean(data.telegram?.hasToken));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек Telegram');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveTelegramSettings(event) {
    event.preventDefault();
    setIsSavingTelegramSettings(true);
    setStatus('Сохраняем настройки Telegram...');

    try {
      const response = await apiFetch('/api/settings/telegram', {
        method: 'PATCH',
        body: JSON.stringify(telegramSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки Telegram');
      }

      setTelegramSettingsDraft((current) => ({ ...current, botToken: '' }));
      setTelegramHasToken(Boolean(data.telegram?.hasToken));
      setStatus('Настройки Telegram сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек Telegram');
    } finally {
      setIsSavingTelegramSettings(false);
    }
  }

  async function loadBitrixSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/bitrix');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки Битрикс24');
      }

      setBitrixSettingsDraft({
        webhookUrl: '',
        defaultResponsibleId: data.bitrix?.defaultResponsibleId || '',
        defaultGroupId: data.bitrix?.defaultGroupId || '',
      });
      setBitrixHasWebhook(Boolean(data.bitrix?.hasWebhook));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек Битрикс24');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveBitrixSettings(event) {
    event.preventDefault();
    setIsSavingBitrixSettings(true);
    setStatus('Сохраняем настройки Битрикс24...');

    try {
      const response = await apiFetch('/api/settings/bitrix', {
        method: 'PATCH',
        body: JSON.stringify(bitrixSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки Битрикс24');
      }

      setBitrixSettingsDraft((current) => ({ ...current, webhookUrl: '' }));
      setBitrixHasWebhook(Boolean(data.bitrix?.hasWebhook));
      setStatus('Настройки Битрикс24 сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек Битрикс24');
    } finally {
      setIsSavingBitrixSettings(false);
    }
  }

  async function loadDiarizationSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/diarization');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки диаризации');
      }

      setDiarizationSettingsDraft({
        method: data.diarization?.method || 'shopot',
        shopotApiKey: '',
        geminiModel: data.diarization?.geminiModel || 'google/gemini-2.5-pro',
        speech2textApiKey: '',
        kimiModel: data.diarization?.kimiModel || 'moonshotai/kimi-k2.6',
        language: data.diarization?.language || '',
      });
      setDiarizationHasShopotKey(Boolean(data.diarization?.hasShopotKey));
      setDiarizationHasSpeech2textKey(Boolean(data.diarization?.hasSpeech2textKey));
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек диаризации');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveDiarizationSettings(event) {
    event.preventDefault();
    setIsSavingDiarizationSettings(true);
    setStatus('Сохраняем настройки диаризации...');

    try {
      const response = await apiFetch('/api/settings/diarization', {
        method: 'PATCH',
        body: JSON.stringify(diarizationSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки диаризации');
      }

      setDiarizationSettingsDraft((current) => ({ ...current, shopotApiKey: '', speech2textApiKey: '' }));
      setDiarizationHasShopotKey(Boolean(data.diarization?.hasShopotKey));
      setDiarizationHasSpeech2textKey(Boolean(data.diarization?.hasSpeech2textKey));
      setStatus('Настройки диаризации сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек диаризации');
    } finally {
      setIsSavingDiarizationSettings(false);
    }
  }

  async function loadNotificationSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/notifications');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки уведомлений');
      }

      setNotificationSettingsDraft({
        channels: data.notifications?.channels || ['in_app', 'email'],
        dnd: Boolean(data.notifications?.dnd),
      });
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек уведомлений');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveNotificationSettings(event) {
    event.preventDefault();
    setIsSavingNotificationSettings(true);
    setStatus('Сохраняем настройки уведомлений...');

    try {
      const response = await apiFetch('/api/settings/notifications', {
        method: 'PATCH',
        body: JSON.stringify(notificationSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки уведомлений');
      }

      setNotificationSettingsDraft({
        channels: data.notifications?.channels || ['in_app', 'email'],
        dnd: Boolean(data.notifications?.dnd),
      });
      setStatus('Настройки уведомлений сохранены');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек уведомлений');
    } finally {
      setIsSavingNotificationSettings(false);
    }
  }

  async function loadSendSettings() {
    setIsSettingsLoading(true);

    try {
      const response = await apiFetch('/api/settings/send');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить настройки отправки');
      }

      setSendSettingsDraft(data.send);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки настроек отправки');
    } finally {
      setIsSettingsLoading(false);
    }
  }

  async function handleSaveSendSettings(event) {
    event.preventDefault();
    setIsSavingSendSettings(true);
    setStatus('Сохраняем настройки отправки...');

    try {
      const response = await apiFetch('/api/settings/send', {
        method: 'PATCH',
        body: JSON.stringify(sendSettingsDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить настройки отправки');
      }

      setSendSettingsDraft(data.send);
      setStatus('Настройки отправки сохранены');
      onSendConfigSaved?.(data.send);
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения настроек отправки');
    } finally {
      setIsSavingSendSettings(false);
    }
  }

  function loadAllSettings() {
    loadSmtpSettings();
    loadTelegramSettings();
    loadBitrixSettings();
    loadDiarizationSettings();
    loadNotificationSettings();
    loadSendSettings();
  }

  return {
    smtpDraft,
    setSmtpDraft,
    smtpHasPassword,
    telegramSettingsDraft,
    setTelegramSettingsDraft,
    telegramHasToken,
    isSavingTelegramSettings,
    bitrixSettingsDraft,
    setBitrixSettingsDraft,
    bitrixHasWebhook,
    isSavingBitrixSettings,
    diarizationSettingsDraft,
    setDiarizationSettingsDraft,
    diarizationHasShopotKey,
    diarizationHasSpeech2textKey,
    isSavingDiarizationSettings,
    notificationSettingsDraft,
    setNotificationSettingsDraft,
    isSavingNotificationSettings,
    sendSettingsDraft,
    setSendSettingsDraft,
    isSavingSendSettings,
    isSettingsLoading,
    isSavingSettings,
    loadAllSettings,
    handleSaveSmtpSettings,
    handleSaveTelegramSettings,
    handleSaveBitrixSettings,
    handleSaveDiarizationSettings,
    handleSaveNotificationSettings,
    handleSaveSendSettings,
  };
}
