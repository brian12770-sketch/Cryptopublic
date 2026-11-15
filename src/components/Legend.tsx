import type { Mode } from '../types';
import { LEGENDS } from '../lib/scale';

export function Legend({ mode }: { mode: Mode }) {
  const { title, stops } = LEGENDS[mode];
  return (
    <div className="legend">
      <span className="legend-title">{title}</span>
      <ul className="legend-stops">
        {stops.map((s) => (
          <li key={s.cls}>
            <span className={`swatch c-${s.cls}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
        {mode !== 'change' && (
          <li>
            <span className="swatch c-nodata" aria-hidden="true" />
            無資料
          </li>
        )}
      </ul>
      <span className="legend-note">方塊面積：24 小時成交額（開根號比例）</span>
    </div>
  );
}
