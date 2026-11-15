import type { Mode } from '../types';
import { CHANGE_LEGEND, HEAT_LEGEND } from '../lib/scale';

export function Legend({ mode }: { mode: Mode }) {
  const stops = mode === 'heat' ? HEAT_LEGEND : CHANGE_LEGEND;
  return (
    <div className="legend">
      <span className="legend-title">{mode === 'heat' ? '量能倍數' : '24 小時漲跌'}</span>
      <ul className="legend-stops">
        {stops.map((s) => (
          <li key={s.cls}>
            <span className={`swatch c-${s.cls}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
        {mode === 'heat' && (
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
