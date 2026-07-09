import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useUiStore = create(
  persist(
    (set, get) => ({
      theme: 'dark',
      isVoicePanelOpen: false,
      activeSwipeCardId: null,

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      openVoicePanel: () => set({ isVoicePanelOpen: true }),
      closeVoicePanel: () => set({ isVoicePanelOpen: false }),
      setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
    }),
    {
      name: 'voxmate-ui',
      partialize: (state) => ({ theme: state.theme }),
    },
  ),
);

export default useUiStore;
