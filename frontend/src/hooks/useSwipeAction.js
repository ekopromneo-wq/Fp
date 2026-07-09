import { useRef } from 'react';

const THRESHOLD = 80;
const REVEAL_START = 20;

export default function useSwipeAction({ onSwipeLeft, onSwipeRight, enabled = true }) {
  const cardRef = useRef(null);
  const trackRef = useRef(null);
  const startXRef = useRef(0);
  const draggingRef = useRef(false);

  function resetVisuals() {
    const card = cardRef.current;
    const track = trackRef.current;

    if (card) {
      card.style.transition = 'transform 0.2s ease';
      card.style.transform = 'translateX(0)';
    }

    if (track) {
      track.style.transition = 'background 0.2s ease';
      track.style.background = 'transparent';
    }

    window.setTimeout(() => {
      if (card) card.style.transition = '';
      if (track) track.style.transition = '';
    }, 220);
  }

  function handlePointerDown(event) {
    if (!enabled) return;
    draggingRef.current = true;
    startXRef.current = event.clientX;
  }

  function handlePointerMove(event) {
    if (!enabled || !draggingRef.current || !cardRef.current) return;

    const delta = event.clientX - startXRef.current;
    cardRef.current.style.transform = `translateX(${delta}px)`;

    const track = trackRef.current;
    if (track) {
      if (delta > REVEAL_START) {
        track.style.background = 'var(--accent-success)';
      } else if (delta < -REVEAL_START) {
        track.style.background = 'var(--accent-warning)';
      } else {
        track.style.background = 'transparent';
      }
    }
  }

  function handlePointerUp(event) {
    if (!enabled || !draggingRef.current) return;
    draggingRef.current = false;

    const delta = event.clientX - startXRef.current;
    resetVisuals();

    if (delta > THRESHOLD) {
      onSwipeRight?.();
    } else if (delta < -THRESHOLD) {
      onSwipeLeft?.();
    }
  }

  return {
    cardRef,
    trackRef,
    handlers: enabled
      ? {
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerUp,
        }
      : {},
  };
}
