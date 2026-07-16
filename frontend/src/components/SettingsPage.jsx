import { useState } from 'react';
import DiarizationSettingsPanel from './settings/DiarizationSettingsPanel.jsx';
import SmtpSettingsPanel from './settings/SmtpSettingsPanel.jsx';
import TelegramSettingsPanel from './settings/TelegramSettingsPanel.jsx';
import BitrixSettingsPanel from './settings/BitrixSettingsPanel.jsx';
import NotificationSettingsPanel from './settings/NotificationSettingsPanel.jsx';
import SendSettingsPanel from './settings/SendSettingsPanel.jsx';
import BalancesPanel from './settings/BalancesPanel.jsx';
import AccountPanel from './settings/AccountPanel.jsx';
import MicrophoneSettingsPanel from './settings/MicrophoneSettingsPanel.jsx';

// Вкладки вместо одного скролла на ~5700px: связанные настройки собраны по
// смыслу. Обработка — устройство записи, метод диаризации и балансы сервисов
// (метод и его баланс — один вопрос). Интеграции — все каналы отправки.
const TABS = [
  { key: 'account', label: 'Аккаунт' },
  { key: 'processing', label: 'Обработка' },
  { key: 'integrations', label: 'Интеграции' },
  { key: 'notifications', label: 'Уведомления' },
];

function SettingsPage({ settings, micDeviceId, setMicDeviceId, status, currentUser, onLoggedOut, setStatus }) {
  const [tab, setTab] = useState('account');

  return (
    <section className="settings-page" aria-label="Настройки">
      <div className="settings-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`settings-tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'account' ? (
        <AccountPanel currentUser={currentUser} onLoggedOut={onLoggedOut} setStatus={setStatus} />
      ) : null}

      {tab === 'processing' ? (
        <>
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

          <BalancesPanel
            balances={settings.balances}
            isLoading={settings.isLoadingBalances}
            onRefresh={settings.loadBalances}
            checkedAt={settings.balances?.[0]?.checkedAt}
          />
        </>
      ) : null}

      {tab === 'integrations' ? (
        <>
          <SendSettingsPanel
            draft={settings.sendSettingsDraft}
            setDraft={settings.setSendSettingsDraft}
            onSubmit={settings.handleSaveSendSettings}
            isSaving={settings.isSavingSendSettings}
            isSettingsLoading={settings.isSettingsLoading}
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
        </>
      ) : null}

      {tab === 'notifications' ? (
        <NotificationSettingsPanel
          draft={settings.notificationSettingsDraft}
          setDraft={settings.setNotificationSettingsDraft}
          onSubmit={settings.handleSaveNotificationSettings}
          isSaving={settings.isSavingNotificationSettings}
          isSettingsLoading={settings.isSettingsLoading}
        />
      ) : null}

      <section className="status-line" aria-live="polite">
        {status || 'Настройки применяются сразу после сохранения.'}
      </section>
    </section>
  );
}

export default SettingsPage;
