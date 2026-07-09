import { create } from 'zustand';

const useUiStore = create((set) => ({
  theme: 'dark',
  isVoicePanelOpen: false,
  activeSwipeCardId: null,

  openVoicePanel: () => set({ isVoicePanelOpen: true }),
  closeVoicePanel: () => set({ isVoicePanelOpen: false }),
  setActiveSwipeCardId: (id) => set({ activeSwipeCardId: id }),
}));

export default useUiStore;
