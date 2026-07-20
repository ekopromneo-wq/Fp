import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useUiStore = create(
  persist(
    (set, get) => ({
      theme: 'dark',
      isVoicePanelOpen: false,
      activeSwipeCardId: null,
      micDeviceId: '',
      // US-1.1: звуковой сигнал в начале записи — по настройке пользователя.
      // По умолчанию выключен, чтобы старт оставался беззвучным «в один тап».
      startSoundEnabled: false,
      // US-3.4: не выгружать записи через мобильную сеть (экономия трафика).
      // Ручная синхронизация игнорирует этот запрет (осознанное действие).
      blockMobileUpload: false,
      // US-3.5: где хранить новые записи. 'cloud' (по умолчанию) — выгрузка и
      // облачная обработка; 'device' — только на устройстве, без выгрузки и без
      // расшифровки/протокола (при удалении приложения запись теряется).
      storageMode: 'cloud',
      // US-13.1: «экран настраивается» — скрытые блоки главного экрана.
      hiddenHomeBlocks: [],
      // ADR-035 §4.3: идёт ли активная запись. Обновление PWA во время записи
      // откладывается, чтобы не прервать сценарий молчаливой перезагрузкой.
      // Транзиентный флаг — намеренно не персистится.
      isRecordingActive: false,

      setRecordingActive: (active) => set({ isRecordingActive: Boolean(active) }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      openVoicePanel: () => set({ isVoicePanelOpen: true }),
      closeVoicePanel: () => set({ isVoicePanelOpen: false }),
      setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
      setMicDeviceId: (deviceId) => set({ micDeviceId: deviceId }),
      setStartSoundEnabled: (enabled) => set({ startSoundEnabled: Boolean(enabled) }),
      setBlockMobileUpload: (enabled) => set({ blockMobileUpload: Boolean(enabled) }),
      setStorageMode: (mode) => set({ storageMode: mode === 'device' ? 'device' : 'cloud' }),
      toggleHomeBlock: (key) =>
        set({
          hiddenHomeBlocks: get().hiddenHomeBlocks.includes(key)
            ? get().hiddenHomeBlocks.filter((item) => item !== key)
            : [...get().hiddenHomeBlocks, key],
        }),
    }),
    {
      name: 'voxmate-ui',
      partialize: (state) => ({
        theme: state.theme,
        micDeviceId: state.micDeviceId,
        startSoundEnabled: state.startSoundEnabled,
        blockMobileUpload: state.blockMobileUpload,
        storageMode: state.storageMode,
        hiddenHomeBlocks: state.hiddenHomeBlocks,
      }),
    },
  ),
);

export default useUiStore;
