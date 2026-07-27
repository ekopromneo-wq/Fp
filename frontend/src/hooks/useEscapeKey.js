import { useEffect } from 'react';

// STG-062: раньше ни одна модалка не закрывалась по Escape - только клик по
// подложке (легко промахнуться) или (не везде) явный крестик.
export default function useEscapeKey(onEscape) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onEscape();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onEscape]);
}
