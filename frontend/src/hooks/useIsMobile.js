import { useEffect, useState } from 'react';

// Keep this breakpoint numerically identical to the `@media (min-width: 981px)`
// desktop split in App.css — plain CSS can't read a JS constant here.
const MOBILE_QUERY = '(max-width: 980px)';

export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_QUERY);
    const handleChange = (event) => setIsMobile(event.matches);

    mediaQuery.addEventListener('change', handleChange);
    setIsMobile(mediaQuery.matches);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isMobile;
}
