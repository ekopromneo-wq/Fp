import { useRef } from 'react';

const THRESHOLD = 80;
const REVEAL_START = 20;
// Пока палец не сдвинулся на столько пикселей, направление жеста неизвестно:
// каждое касание списка начинается одинаково и для скролла, и для свайпа.
const DIRECTION_LOCK = 12;

export default function useSwipeAction({ onSwipeLeft, onSwipeRight, enabled = true }) {
  const cardRef = useRef(null);
  const trackRef = useRef(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const draggingRef = useRef(false);
  const axisRef = useRef(null);
  const suppressClickRef = useRef(false);

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
    axisRef.current = null;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
  }

  function handlePointerMove(event) {
    if (!enabled || !draggingRef.current || !cardRef.current) return;

    const delta = event.clientX - startXRef.current;
    const deltaY = event.clientY - startYRef.current;

    if (!axisRef.current) {
      if (Math.max(Math.abs(delta), Math.abs(deltaY)) < DIRECTION_LOCK) {
        return;
      }

      // Вертикальный жест — это скролл списка: карточка отдаёт его браузеру и
      // больше не участвует, иначе горизонтальный «дрейф» пальца при скролле
      // дотягивал до порога и срабатывало действие (удаление).
      axisRef.current = Math.abs(delta) > Math.abs(deltaY) ? 'x' : 'y';

      if (axisRef.current === 'y') {
        draggingRef.current = false;
        return;
      }
    }

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

    const wasHorizontal = axisRef.current === 'x';
    draggingRef.current = false;
    axisRef.current = null;

    if (!wasHorizontal) return;

    const delta = event.clientX - startXRef.current;
    resetVisuals();

    // Свайп — самостоятельное действие: клик по карточке (открыть запись) после
    // него не нужен.
    suppressClickRef.current = Math.abs(delta) > REVEAL_START;

    if (delta > THRESHOLD) {
      onSwipeRight?.();
    } else if (delta < -THRESHOLD) {
      onSwipeLeft?.();
    }
  }

  // Браузер забирает касание себе (начался скролл, звонок, системный жест) —
  // жест не состоялся, действие не выполняем.
  function handlePointerCancel() {
    if (!enabled || !draggingRef.current) return;

    const wasHorizontal = axisRef.current === 'x';
    draggingRef.current = false;
    axisRef.current = null;

    if (wasHorizontal) {
      resetVisuals();
    }
  }

  function handleClickCapture(event) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return {
    cardRef,
    trackRef,
    handlers: enabled
      ? {
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerCancel,
          onClickCapture: handleClickCapture,
        }
      : {},
  };
}
