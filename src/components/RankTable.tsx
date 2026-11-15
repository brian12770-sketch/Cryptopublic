import { useMemo, useState } from 'react';
import type { HeatState, Mode, Ticker } from '../types';
import { fmtPct, fmtPrice, fmtRatio, fmtTurnover } from '../lib/format';
import { heatClass } from '../lib/scale';

type SortKey = 'turnover' | 'change' | 'heat';

interface Props {
  tickers: Ticker[];
  heat: Record<string, HeatState>;
  mode: Mode;
  activeKey: string | null;
  onSelect(key: string): void;
}

const COLLAPSED_ROWS = 12;

function ratioOf(state: HeatState | undefined): number {
  return state?.kind === 'ok' ? state.heat.ratio : -Infinity;
}

export function HeatCell({ state }: { state: HeatState | undefined }) {
  if (!state || state.kind === 'pending') return <span className="muted">計算中</span>;
  if (state.kind === 'insufficient') {
    return (
      <span className="muted" title="上市未滿一天，或最近一小時沒有成交資料，無法計算基準">
        資料不足
      </span>
    );
  }
  if (state.kind === 'failed') {
    return (
      <span className="failed" title={state.message}>
        <span aria-hidden="true">✕</span> 抓取失敗
      </span>
    );
  }
  return (
    <span className="heat-cell">
      <span className={`swatch c-${heatClass(state.heat.ratio)}`} aria-hidden="true" />
      {fmtRatio(state.heat.ratio)}
    </span>
  );
}

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

export function RankTable({ tickers, heat, mode, activeKey, onSelect }: Props) {
  // null = follow the mode: anomaly ranking in heat mode, turnover otherwise.
  const [chosen, setChosen] = useState<SortKey | null>(null);
  const [expanded, setExpanded] = useState(false);
  const sortKey: SortKey = chosen ?? (mode === 'heat' ? 'heat' : 'turnover');

  const rows = useMemo(() => {
    const list = [...tickers];
    if (sortKey === 'turnover') list.sort((a, b) => b.turnover24h - a.turnover24h);
    else if (sortKey === 'change') list.sort((a, b) => b.changePct - a.changePct);
    else list.sort((a, b) => ratioOf(heat[b.symbol]) - ratioOf(heat[a.symbol]) || b.turnover24h - a.turnover24h);
    return list;
  }, [tickers, heat, sortKey]);

  const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  const header = (key: SortKey, label: string) => (
    <th scope="col" className="num" aria-sort={sortKey === key ? 'descending' : 'none'}>
      <button type="button" className={`sort${sortKey === key ? ' is-on' : ''}`} onClick={() => setChosen(key)}>
        {label}
        <span aria-hidden="true">{sortKey === key ? ' ↓' : ''}</span>
      </button>
    </th>
  );

  return (
    <div className="rank">
      <table>
        <thead>
          <tr>
            <th scope="col" className="rank-n">
              #
            </th>
            <th scope="col">合約</th>
            <th scope="col" className="num">
              價格
            </th>
            {header('change', '24h')}
            {header('turnover', '成交額')}
            {header('heat', '量能')}
          </tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr
              key={t.symbol}
              className={activeKey === t.symbol ? 'is-active' : undefined}
              onClick={() => onSelect(t.symbol)}
            >
              <td className="rank-n">{i + 1}</td>
              <th scope="row">{t.base}</th>
              <td className="num">{fmtPrice(t.price)}</td>
              <td className="num">
                <Delta pct={t.changePct} />
              </td>
              <td className="num">
                {t.turnoverApprox ? '≈' : ''}
                {fmtTurnover(t.turnover24h)}
              </td>
              <td className="num">
                <HeatCell state={heat[t.symbol]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > COLLAPSED_ROWS && (
        <button type="button" className="more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收合' : `顯示全部 ${rows.length} 檔`}
        </button>
      )}
    </div>
  );
}
