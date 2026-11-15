import { useMemo, useRef, useState } from 'react';
import type { Mode } from '../types';
import type { ExchangeData } from '../lib/useExchange';
import { linkOf } from '../lib/useExchange';
import { HOUR_MS } from '../lib/heat';
import { fmtClock, fmtHourMinute, fmtPct, fmtPrice, fmtRatio, fmtTurnover } from '../lib/format';
import { tileClass, tileValue } from '../lib/scale';
import { Treemap, type Tile } from './Treemap';
import { Legend } from './Legend';
import { Delta, HeatCell, RankTable } from './RankTable';

interface Props {
  data: ExchangeData;
  mode: Mode;
  now: number;
}

const STATUS = {
  connecting: { icon: '…', label: '連線中' },
  live: { icon: '●', label: '更新中' },
  stale: { icon: '▲', label: '延遲' },
  down: { icon: '✕', label: '中斷' },
} as const;

/** Re-run the treemap layout at most this often, so tiles hold still between ticks. */
const RELAYOUT_MS = 60_000;

export function ExchangePanel({ data, mode, now }: Props) {
  const { adapter, top, heat, lastOk, error, listed, heatBarTime } = data;
  const link = linkOf(data, now);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const activeKey = hovered ?? selected;

  // Layout snapshot: refreshed when the top-50 membership changes or once a minute.
  const snapshot = useRef({ key: '', at: 0, sizes: new Map<string, number>() });
  const members = top
    .map((t) => t.symbol)
    .sort()
    .join(',');
  if (snapshot.current.key.split('|')[0] !== members || now - snapshot.current.at > RELAYOUT_MS) {
    snapshot.current = {
      key: `${members}|${now}`,
      at: now,
      sizes: new Map(top.map((t) => [t.symbol, t.turnover24h])),
    };
  }
  const layoutKey = snapshot.current.key;
  const sizes = snapshot.current.sizes;

  const tiles: Tile[] = useMemo(
    () =>
      top.map((t) => {
        const state = heat[t.symbol];
        const ratio = state?.kind === 'ok' ? `，量能 ${fmtRatio(state.heat.ratio)}` : '';
        return {
          key: t.symbol,
          label: t.base,
          value: tileValue(mode, t, state),
          cls: tileClass(mode, t, state),
          size: sizes.get(t.symbol) ?? t.turnover24h,
          description: `${t.base}，價格 ${fmtPrice(t.price)}，24 小時 ${fmtPct(t.changePct)}，成交額 ${fmtTurnover(t.turnover24h)} USDT${ratio}`,
        };
      }),
    [top, heat, mode, sizes],
  );

  const active = activeKey ? top.find((t) => t.symbol === activeKey) : undefined;

  const counts = useMemo(() => {
    let ok = 0;
    let failed = 0;
    let thin = 0;
    for (const t of top) {
      const s = heat[t.symbol];
      if (s?.kind === 'ok') ok++;
      else if (s?.kind === 'failed') failed++;
      else if (s?.kind === 'insufficient') thin++;
    }
    return { ok, failed, thin };
  }, [top, heat]);

  const status = STATUS[link];
  const hasData = top.length > 0;

  return (
    <section className={`panel link-${link}`} aria-label={`${adapter.name} USDT 永續合約`}>
      <header className="panel-head">
        <h2>{adapter.name}</h2>
        <span className={`status is-${link}`}>
          <span aria-hidden="true">{status.icon}</span> {status.label}
          {lastOk !== null && <span className="status-time"> · {fmtClock(lastOk)}</span>}
        </span>
      </header>

      {link === 'down' && (
        <p className="alert" role="alert">
          <strong>{lastOk === null ? '連不上，沒有資料可顯示。' : `連線中斷，下面的數字停在 ${fmtClock(lastOk)}。`}</strong>
          {error && <span> {error}</span>}
        </p>
      )}
      {link === 'stale' && (
        <p className="alert is-warn" role="status">
          資料延遲，最後一次更新是 {lastOk !== null ? fmtClock(lastOk) : '—'}。{error}
        </p>
      )}

      {hasData ? (
        <div className={link === 'down' || link === 'stale' ? 'body is-dim' : 'body'}>
          <Treemap
            tiles={tiles}
            layoutKey={layoutKey}
            activeKey={activeKey}
            onHover={setHovered}
            onSelect={(key) => setSelected((cur) => (cur === key ? null : key))}
          />

          <div className="readout" aria-live="off">
            {active ? (
              <>
                <strong>{active.base}</strong>
                <span>{fmtPrice(active.price)}</span>
                <Delta pct={active.changePct} />
                <span>
                  成交額 {active.turnoverApprox ? '≈' : ''}
                  {fmtTurnover(active.turnover24h)}
                </span>
                <span>
                  量能 <HeatCell state={heat[active.symbol]} />
                </span>
              </>
            ) : (
              <span className="muted">點方塊或表格列看明細</span>
            )}
          </div>

          <Legend mode={mode} />

          <p className="meta">
            成交額前 {top.length} 名，共 {listed} 檔 USDT 永續合約。成交額為{adapter.turnoverNote}。
            <br />
            量能倍數＝
            {heatBarTime !== null
              ? `${fmtHourMinute(heatBarTime)}–${fmtHourMinute(heatBarTime + HOUR_MS)} 這一小時`
              : '最近一個完整小時'}
            的成交額 ÷ 前 7 天每小時成交額的中位數。已算出 {counts.ok}/{top.length} 檔
            {counts.thin > 0 && `，${counts.thin} 檔資料不足`}
            {counts.failed > 0 && `，${counts.failed} 檔抓取失敗`}。
          </p>

          <RankTable
            tickers={top}
            heat={heat}
            mode={mode}
            activeKey={activeKey}
            onSelect={(key) => setSelected((cur) => (cur === key ? null : key))}
          />
        </div>
      ) : (
        link !== 'down' && <p className="empty">正在向 {adapter.name} 取得行情…</p>
      )}
    </section>
  );
}
