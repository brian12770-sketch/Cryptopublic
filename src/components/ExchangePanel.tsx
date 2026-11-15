import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { Mode } from '../types';
import type { CandleSource } from '../lib/candles';
import type { ExchangeData } from '../lib/useExchange';
import { linkOf } from '../lib/useExchange';
import { BAR_MS } from '../lib/metrics';
import { fmtClock, fmtHourMinute, fmtPct, fmtPrice, fmtTurnover } from '../lib/format';
import { modeCell, tileClass, tileValue } from '../lib/scale';
import { Treemap, type Tile } from './Treemap';
import { Legend } from './Legend';
import { Delta, DeltaCell, OiCell, RankTable, RvolCell, TakerCell } from './RankTable';

// The charting library is only needed once a contract is opened.
const KlineChart = lazy(() => import('./KlineChart'));

interface Props {
  data: ExchangeData;
  mode: Mode;
  now: number;
  /** Listings per exchange, for finding the selected coin's contract on each. */
  listings: Record<CandleSource, ReadonlySet<string>>;
}

const STATUS = {
  connecting: { icon: '…', label: '連線中' },
  live: { icon: '●', label: '更新中' },
  stale: { icon: '▲', label: '延遲' },
  down: { icon: '✕', label: '中斷' },
} as const;

const MODE_NAME: Record<Mode, string> = { rvol: 'RVOL', oi: 'OI 變化', taker: '買賣比', change: '漲跌' };

/** Re-run the treemap layout at most this often, so tiles hold still between ticks. */
const RELAYOUT_MS = 60_000;

export function ExchangePanel({ data, mode, now, listings }: Props) {
  const { adapter, top, metrics, lastOk, error, listed, barTime } = data;
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
        const m = metrics[t.symbol];
        const value = tileValue(mode, t, m);
        const extra = mode === 'change' ? '' : `，${MODE_NAME[mode]} ${value}`;
        return {
          key: t.symbol,
          label: t.base,
          value,
          cls: tileClass(mode, t, m),
          size: sizes.get(t.symbol) ?? t.turnover24h,
          description: `${t.base}，價格 ${fmtPrice(t.price)}，24 小時 ${fmtPct(t.changePct)}，成交額 ${fmtTurnover(t.turnover24h)} USDT${extra}`,
        };
      }),
    [top, metrics, mode, sizes],
  );

  const active = activeKey ? top.find((t) => t.symbol === activeKey) : undefined;
  const activeMetrics = active ? metrics[active.symbol] : undefined;

  // How many contracts have a value for the metric the map is coloured by.
  const counts = useMemo(() => {
    let ok = 0;
    let failed = 0;
    let thin = 0;
    for (const t of top) {
      const cell = modeCell(mode === 'change' ? 'rvol' : mode, metrics[t.symbol]);
      if (cell?.kind === 'ok') ok++;
      else if (cell?.kind === 'failed') failed++;
      else if (cell?.kind === 'insufficient') thin++;
    }
    return { ok, failed, thin };
  }, [top, metrics, mode]);

  // Open-interest snapshots can trail the candle by one bar; say so when they do.
  const oiLag = useMemo(() => {
    if (barTime === null) return false;
    return top.some((t) => {
      const at = metrics[t.symbol]?.oiTime;
      return at !== null && at !== undefined && at < barTime + BAR_MS;
    });
  }, [top, metrics, barTime]);

  const status = STATUS[link];
  const hasData = top.length > 0;
  const barLabel =
    barTime !== null ? `${fmtHourMinute(barTime)}–${fmtHourMinute(barTime + BAR_MS)}` : '最近一根';
  const toggle = (key: string) => setSelected((cur) => (cur === key ? null : key));

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
          <Treemap tiles={tiles} layoutKey={layoutKey} activeKey={activeKey} onHover={setHovered} onSelect={toggle} />

          <div className="readout" aria-live="off">
            {active ? (
              <>
                <strong>{active.base}</strong>
                <span>{fmtPrice(active.price)}</span>
                <span>
                  24h <Delta pct={active.changePct} />
                </span>
                <span>
                  15m <DeltaCell cell={activeMetrics?.ret15} />
                </span>
                <span>
                  成交額 {active.turnoverApprox ? '≈' : ''}
                  {fmtTurnover(active.turnover24h)}
                </span>
                <span>
                  RVOL <RvolCell cell={activeMetrics?.rvol} />
                </span>
                <span>
                  OI 15m <OiCell cell={activeMetrics?.oi15} />
                </span>
                <span>
                  OI 1h <OiCell cell={activeMetrics?.oi1h} />
                </span>
                <span>
                  買賣比 <TakerCell cell={activeMetrics?.taker} />
                </span>
              </>
            ) : (
              <span className="muted">點方塊或表格列看明細與 K 線</span>
            )}
          </div>

          {selected && top.some((t) => t.symbol === selected) && (
            <Suspense fallback={<p className="kline-foot muted">載入圖表…</p>}>
              <KlineChart
                key={selected}
                base={top.find((t) => t.symbol === selected)!.base}
                listed={listings}
                onClose={() => setSelected(null)}
              />
            </Suspense>
          )}

          <Legend mode={mode} />

          <details className="meta">
            <summary>
              15m、RVOL、OI、買賣比都是 {barLabel} 這根 15 分鐘 K 棒的數字。
              {mode !== 'change' && (
                <>
                  {' '}
                  {MODE_NAME[mode]} 已算出 {counts.ok}/{top.length} 檔
                  {counts.thin > 0 && `，${counts.thin} 檔資料不足`}
                  {counts.failed > 0 && `，${counts.failed} 檔抓取失敗`}。
                </>
              )}
              {oiLag && ' 部分 OI 是前一根的快照，交易所還沒公布最新一筆。'}
            </summary>
            <ul>
              <li>範圍：成交額前 {top.length} 名，共 {listed} 檔 USDT 永續合約。成交額為{adapter.turnoverNote}。</li>
              <li>15m：這根 K 棒從開盤到收盤的漲跌。</li>
              <li>RVOL：這根 K 棒的成交額 ÷ 前 3 天所有 15 分鐘 K 棒成交額的中位數。</li>
              <li>OI：未平倉量（幣數）在這根 K 棒期間的變化；明細另有近 1 小時的變化。</li>
              <li>買賣比：這根 K 棒內主動買入成交額 ÷ 主動賣出成交額，大於 1 代表買方較積極。</li>
            </ul>
          </details>

          <RankTable tickers={top} metrics={metrics} mode={mode} activeKey={activeKey} onSelect={toggle} />
        </div>
      ) : (
        link !== 'down' && <p className="empty">正在向 {adapter.name} 取得行情…</p>
      )}
    </section>
  );
}
