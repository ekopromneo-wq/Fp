// Фирменный знак: микрофон на стойке с 4 строками стенограммы внутри капсулы
// (символизирует «речь → текст»). Единая форма для FAB, PWA-иконки, индикатора
// обработки и центральной кнопки записи — см. референс дизайна продукта.
// Капсула узкая и высокая (10:16), как в референсе, а не приплюснутая.
//
// level (0..1 или null) — реальный уровень сигнала с микрофона (RMS от
// useMicRecorder). Один физический сигнал, но 4 линии берут его с разным весом
// (STAGGER) — не выдуманные независимые данные, а честная развёртка одного
// значения в «эквалайзер», чтобы полосы двигались неравномерно и живо.
// null/не задан — линии статичны на полную ширину (иконка «в покое»).
const STAGGER = [0.6, 1, 0.8, 0.42];
const LINE_Y = [4.7, 7.7, 10.7, 13.7];
const LINE_WIDTH = 6;

export default function BrandMicIcon({ level = null, className }) {
  return (
    <svg className={className} viewBox="0 0 32 34" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Капсула микрофона — узкая и высокая (10×16), не приплюснутая. */}
      <rect x="11" y="2" width="10" height="16" rx="5" fill="currentColor" opacity="0.16" />
      <rect x="11" y="2" width="10" height="16" rx="5" stroke="currentColor" strokeWidth="1.6" />
      {/* Строки внутри капсулы — «полосочки», в записи масштабируются по уровню сигнала. */}
      {LINE_Y.map((y, index) => {
        const scale = level === null ? 1 : Math.max(0.18, Math.min(1, level * STAGGER[index] + 0.12));
        return (
          <rect
            key={index}
            x={16 - LINE_WIDTH / 2}
            y={y}
            width={LINE_WIDTH}
            height="1.6"
            rx="0.8"
            fill="currentColor"
            style={{
              transformBox: 'fill-box',
              transformOrigin: 'center',
              transform: `scaleX(${scale})`,
              transition: level === null ? undefined : 'transform 90ms linear',
            }}
          />
        );
      })}
      {/* Стойка и основание */}
      <path d="M8 19v1a8 8 0 0 0 16 0v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 28v3M12 31h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
