import { breadthOf, BREADTH_RVOL } from '../lib/breadth';
import type { ExchangeData } from '../lib/useExchange';
import { linkOf } from '../lib/useExchange';
import { BAR_MS } from '../lib/metrics';
import { fmtHourMinute } from '../lib/format';

export function BreadthBar({ exchanges, now }: { exchanges: ExchangeData[]; now: number }) {
  const rows = exchanges.map((ex) => ({ ex, link: linkOf(ex, now), b: breadthOf(ex.top, ex.metrics) }));
  const barTime = rows.find((r) => r.b.barTime !== null)?.b.barTime ?? null;
  return (
    <section className="breadth" aria-label="市場廣度">
      <span className="breadth-title">
        市場廣度{barTime !== null && <span className="muted"> · {fmtHourMinute(barTime)}–{fmtHourMinute(barTime + BAR_MS)} K 棒</span>}
      </span>
      {rows.map(({ ex, link, b }) => (
        <span key={ex.adapter.id} className={link === 'down' || link === 'stale' ? 'breadth-item is-dim' : 'breadth-item'}>
          <strong>{ex.adapter.name}</strong>{' '}
          {b.judged === 0 ? (
            <span className="muted">{link === 'down' ? '沒有資料' : '計算中'}</span>
          ) : (
            <>
              <span className="delta-mark is-gain" aria-hidden="true">▲</span>
              漲 {b.up}
              <span className="muted">（放量 {b.upWithVolume}）</span>{' '}
              <span className="delta-mark is-loss" aria-hidden="true">▼</span>
              跌 {b.down}
              <span className="muted">（放量 {b.downWithVolume}）</span>
              <span className="muted"> / {b.judged} 檔</span>
            </>
          )}
        </span>
      ))}
      <span className="breadth-note muted">前 50 名在最近一根 15 分鐘 K 棒的漲跌家數；放量指 RVOL ≥ {BREADTH_RVOL}。</span>
    </section>
  );
}
