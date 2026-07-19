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
      // US-13.1: «экран настраивается» — скрытые блоки главного экрана.
      hiddenHomeBlocks: [],

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      openVoicePanel: () => set({ isVoicePanelOpen: true }),
      closeVoicePanel: () => set({ isVoicePanelOpen: false }),
      setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
      setMicDeviceId: (deviceId) => set({ micDeviceId: deviceId }),
      setStartSoundEnabled: (enabled) => set({ startSoundEnabled: Boolean(enabled) }),
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
        hiddenHomeBlocks: state.hiddenHomeBlocks,
      }),
    },
  ),
);

export default useUiStore;
