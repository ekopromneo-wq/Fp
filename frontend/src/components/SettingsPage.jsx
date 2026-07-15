import DiarizationSettingsPanel from './settings/DiarizationSettingsPanel.jsx';
import SmtpSettingsPanel from './settings/SmtpSettingsPanel.jsx';
import TelegramSettingsPanel from './settings/TelegramSettingsPanel.jsx';
import BitrixSettingsPanel from './settings/BitrixSettingsPanel.jsx';
import NotificationSettingsPanel from './settings/NotificationSettingsPanel.jsx';
import SendSettingsPanel from './settings/SendSettingsPanel.jsx';
import MicrophoneSettingsPanel from './settings/MicrophoneSettingsPanel.jsx';

function SettingsPage({ settings, micDeviceId, setMicDeviceId, status }) {
  return (
    <section className="settings-page" aria-label="Настройки SMTP">
      <MicrophoneSettingsPanel micDeviceId={micDeviceId} setMicDeviceId={setMicDeviceId} />

      <DiarizationSettingsPanel
        draft={settings.diarizationSettingsDraft}
        setDraft={settings.setDiarizationSettingsDraft}
        onSubmit={settings.handleSaveDiarizationSettings}
        isSaving={settings.isSavingDiarizationSettings}
        isSettingsLoading={settings.isSettingsLoading}
        hasShopotKey={settings.diarizationHasShopotKey}
        hasSpeech2textKey={settings.diarizationHasSpeech2textKey}
      />

      <SmtpSettingsPanel
        draft={settings.smtpDraft}
        setDraft={settings.setSmtpDraft}
        onSubmit={settings.handleSaveSmtpSettings}
        isSaving={settings.isSavingSettings}
        isSettingsLoading={settings.isSettingsLoading}
        hasPassword={settings.smtpHasPassword}
      />

      <TelegramSettingsPanel
        draft={settings.telegramSettingsDraft}
        setDraft={settings.setTelegramSettingsDraft}
        onSubmit={settings.handleSaveTelegramSettings}
        isSaving={settings.isSavingTelegramSettings}
        isSettingsLoading={settings.isSettingsLoading}
        hasToken={settings.telegramHasToken}
      />

      <BitrixSettingsPanel
        draft={settings.bitrixSettingsDraft}
        setDraft={settings.setBitrixSettingsDraft}
        onSubmit={settings.handleSaveBitrixSettings}
        isSaving={settings.isSavingBitrixSettings}
        isSettingsLoading={settings.isSettingsLoading}
        hasWebhook={settings.bitrixHasWebhook}
      />

      <NotificationSettingsPanel
        draft={settings.notificationSettingsDraft}
        setDraft={settings.setNotificationSettingsDraft}
        onSubmit={settings.handleSaveNotificationSettings}
        isSaving={settings.isSavingNotificationSettings}
        isSettingsLoading={settings.isSettingsLoading}
      />

      <SendSettingsPanel
        draft={settings.sendSettingsDraft}
        setDraft={settings.setSendSettingsDraft}
        onSubmit={settings.handleSaveSendSettings}
        isSaving={settings.isSavingSendSettings}
        isSettingsLoading={settings.isSettingsLoading}
      />

      <section className="status-line" aria-live="polite">
        {status || 'Настройки будут применены к следующим отправкам протоколов.'}
      </section>
    </section>
  );
}

export default SettingsPage;
