import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useUiStore = create(
  persist(
    (set, get) => ({
      theme: 'dark',
      isVoicePanelOpen: false,
      activeSwipeCardId: null,
      micDeviceId: '',

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      openVoicePanel: () => set({ isVoicePanelOpen: true }),
      closeVoicePanel: () => set({ isVoicePanelOpen: false }),
      setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
      setMicDeviceId: (deviceId) => set({ micDeviceId: deviceId }),
    }),
    {
      name: 'voxmate-ui',
      partialize: (state) => ({ theme: state.theme, micDeviceId: state.micDeviceId }),
    },
  ),
);

export default useUiStore;
