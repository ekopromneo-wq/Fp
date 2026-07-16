import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useUiStore = create(
  persist(
    (set, get) => ({
      theme: 'dark',
      isVoicePanelOpen: false,
      activeSwipeCardId: null,
      micDeviceId: '',
      // US-13.1: «экран настраивается» — скрытые блоки главного экрана.
      hiddenHomeBlocks: [],

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      openVoicePanel: () => set({ isVoicePanelOpen: true }),
      closeVoicePanel: () => set({ isVoicePanelOpen: false }),
      setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
      setMicDeviceId: (deviceId) => set({ micDeviceId: deviceId }),
      toggleHomeBlock: (key) =>
        set({
          hiddenHomeBlocks: get().hiddenHomeBlocks.includes(key)
            ? get().hiddenHomeBlocks.filter((item) => item !== key)
            : [...get().hiddenHomeBlocks, key],
        }),
    }),
    {
      name: 'voxmate-ui',
      partialize: (state) => ({ theme: state.theme, micDeviceId: state.micDeviceId, hiddenHomeBlocks: state.hiddenHomeBlocks }),
    },
  ),
);

export default useUiStore;
