// Фирменный знак: микрофон на стойке с 4 строками стенограммы внутри капсулы
// (символизирует «речь → текст»). Единая форма для FAB, PWA-иконки, индикатора
// обработки и центральной кнопки записи — см. референс дизайна продукта.
//
// level (0..1 или null) — реальный уровень сигнала с микрофона (RMS от
// useMicRecorder). Один физический сигнал, но 4 линии берут его с разным весом
// (STAGGER) — не выдуманные независимые данные, а честная развёртка одного
// значения в «эквалайзер», чтобы полосы двигались неравномерно и живо.
// null/не задан — линии статичны на полную ширину (иконка «в покое»).
const STAGGER = [0.6, 1, 0.8, 0.42];

export default function BrandMicIcon({ level = null, className }) {
  const lineWidths = [16, 16, 16, 16];
  const lineY = [8, 11.2, 14.4, 17.6];

  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Капсула микрофона */}
      <rect x="7" y="4" width="18" height="20" rx="9" fill="currentColor" opacity="0.16" />
      <rect x="7" y="4" width="18" height="20" rx="9" stroke="currentColor" strokeWidth="1.6" />
      {/* Строки внутри капсулы — «полосочки», в записи масштабируются по уровню сигнала. */}
      {lineY.map((y, index) => {
        const scale = level === null ? 1 : Math.max(0.18, Math.min(1, level * STAGGER[index] + 0.12));
        return (
          <rect
            key={index}
            x={16 - lineWidths[index] / 2}
            y={y - 1.1}
            width={lineWidths[index]}
            height="2.2"
            rx="1.1"
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
      <path d="M4 15v1a12 12 0 0 0 24 0v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 28v3M10 31h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
