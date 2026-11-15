import { useMemo, useState } from 'react';
import type { Cell, Metrics, Mode, Ticker } from '../types';
import { fmtPct, fmtPrice, fmtRatio, fmtTaker, fmtTurnover } from '../lib/format';
import { oiClass, rvolClass, takerClass } from '../lib/scale';

type SortKey = 'turnover' | 'change' | 'ret15' | 'rvol' | 'oi' | 'taker';

interface Props {
  tickers: Ticker[];
  metrics: Record<string, Metrics>;
  mode: Mode;
  activeKey: string | null;
  onSelect(key: string): void;
}

const COLLAPSED_ROWS = 12;
const MODE_SORT: Record<Mode, SortKey> = { rvol: 'rvol', oi: 'oi', taker: 'taker', change: 'turnover' };

/** Rows without a value sort last. */
const valueOf = (cell: Cell | undefined): number => (cell?.kind === 'ok' ? cell.value : -Infinity);

/** A metric with its colour swatch, or the reason it is missing. */
export function MetricCell({
  cell,
  format,
  cls,
}: {
  cell: Cell | undefined;
  format(v: number): string;
  cls?(v: number): string;
}) {
  if (!cell || cell.kind === 'pending') return <span className="muted">計算中</span>;
  if (cell.kind === 'insufficient') {
    return (
      <span className="muted" title="交易所沒有提供足夠的資料來計算這個值">
        資料不足
      </span>
    );
  }
  if (cell.kind === 'failed') {
    return (
      <span className="failed" title={cell.message}>
        <span aria-hidden="true">✕</span> 失敗
      </span>
    );
  }
  return (
    <span className="metric">
      {cls && <span className={`swatch c-${cls(cell.value)}`} aria-hidden="true" />}
      {format(cell.value)}
    </span>
  );
}

export const RvolCell = ({ cell }: { cell: Cell | undefined }) => (
  <MetricCell cell={cell} format={fmtRatio} cls={rvolClass} />
);
export const OiCell = ({ cell }: { cell: Cell | undefined }) => <MetricCell cell={cell} format={fmtPct} cls={oiClass} />;
export const TakerCell = ({ cell }: { cell: Cell | undefined }) => (
  <MetricCell cell={cell} format={fmtTaker} cls={takerClass} />
);

export function Delta({ pct }: { pct: number }) {
  const dir = pct > 0 ? 'gain' : pct < 0 ? 'loss' : 'flat';
  return (
    <span className="delta">
      <span className={`delta-mark is-${dir}`} aria-hidden="true">
        {pct > 0 ? '▲' : pct < 0 ? '▼' : '–'}
      </span>
      {fmtPct(pct)}
    </span>
  );
}

/** A price change that may not be computed yet. */
export function DeltaCell({ cell }: { cell: Cell | undefined }) {
  return cell?.kind === 'ok' ? <Delta pct={cell.value} /> : <MetricCell cell={cell} format={fmtPct} />;
}

export function RankTable({ tickers, metrics, mode, activeKey, onSelect }: Props) {
  // null = follow the heatmap mode, so the table ranks by what the map colours.
  const [chosen, setChosen] = useState<{ key: SortKey; mode: Mode } | null>(null);
  const [ascending, setAscending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // A column the reader picked holds until they switch the heatmap mode.
  const picked = chosen && chosen.mode === mode ? chosen.key : null;
  const sortKey: SortKey = picked ?? MODE_SORT[mode];
  const direction = picked ? ascending : false;

  // Clicking the active column flips it, to see the biggest falls as well as rises.
  const pick = (key: SortKey) => {
    setAscending(key === sortKey ? !direction : false);
    setChosen({ key, mode });
  };

  const rows = useMemo(() => {
    const by: Record<SortKey, (t: Ticker) => number> = {
      turnover: (t) => t.turnover24h,
      change: (t) => t.changePct,
      ret15: (t) => valueOf(metrics[t.symbol]?.ret15),
      rvol: (t) => valueOf(metrics[t.symbol]?.rvol),
      oi: (t) => valueOf(metrics[t.symbol]?.oi15),
      taker: (t) => valueOf(metrics[t.symbol]?.taker),
    };
    const key = by[sortKey];
    const sign = direction ? -1 : 1;
    return [...tickers].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      // Rows without a value stay at the bottom in either direction.
      if (x === -Infinity || y === -Infinity) return (y === -Infinity ? 0 : 1) - (x === -Infinity ? 0 : 1);
      return sign * (y - x) || b.turnover24h - a.turnover24h;
    });
  }, [tickers, metrics, sortKey, direction]);

  const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  const header = (key: SortKey, label: string, hint: string) => (
    <th
      scope="col"
      className="num"
      aria-sort={sortKey !== key ? 'none' : direction ? 'ascending' : 'descending'}
      title={hint}
    >
      <button type="button" className={`sort${sortKey === key ? ' is-on' : ''}`} onClick={() => pick(key)}>
        {label}
        <span aria-hidden="true">{sortKey !== key ? '' : direction ? ' ↑' : ' ↓'}</span>
      </button>
    </th>
  );

  return (
    <div className="rank">
      <div className="rank-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="sticky">
                合約
              </th>
              {header('ret15', '15m', '最近一根 15 分鐘 K 棒的漲跌')}
              {header('rvol', 'RVOL', '15 分鐘相對成交量')}
              {header('oi', 'OI', '15 分鐘未平倉量變化')}
              {header('taker', '買賣比', '主動買入 ÷ 主動賣出')}
              <th scope="col" className="num">
                價格
              </th>
              {header('change', '24h', '24 小時漲跌')}
              {header('turnover', '成交額', '24 小時成交額，USDT')}
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const m = metrics[t.symbol];
              return (
                <tr
                  key={t.symbol}
                  className={activeKey === t.symbol ? 'is-active' : undefined}
                  onClick={() => onSelect(t.symbol)}
                >
                  <th scope="row" className="sticky">
                    {t.base}
                  </th>
                  <td className="num">
                    <DeltaCell cell={m?.ret15} />
                  </td>
                  <td className="num">
                    <RvolCell cell={m?.rvol} />
                  </td>
                  <td className="num">
                    <OiCell cell={m?.oi15} />
                  </td>
                  <td className="num">
                    <TakerCell cell={m?.taker} />
                  </td>
                  <td className="num">{fmtPrice(t.price)}</td>
                  <td className="num">
                    <Delta pct={t.changePct} />
                  </td>
                  <td className="num">
                    {t.turnoverApprox ? '≈' : ''}
                    {fmtTurnover(t.turnover24h)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > COLLAPSED_ROWS && (
        <button type="button" className="more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收合' : `顯示全部 ${rows.length} 檔`}
        </button>
      )}
    </div>
  );
}
