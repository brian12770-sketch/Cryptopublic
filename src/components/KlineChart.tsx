import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  LineStyle,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  fetchCandles,
  INTERVALS,
  SOURCE_NAME,
  symbolFor,
  type Candle,
  type CandleSource,
  type Interval,
} from '../lib/candles';
import { FetchError } from '../lib/http';
import { fmtClock } from '../lib/format';

interface Props {
  /** Base asset of the selected contract, e.g. BTC or 1000PEPE. */
  base: string;
  /** Every USDT perpetual each exchange lists; empty while an exchange has not answered. */
  listed: Record<CandleSource, ReadonlySet<string>>;
  onClose(): void;
  /** Exchange to open on; defaults to Binance. */
  initialSource?: CandleSource;
  /** Horizontal lines to draw, valid only on `levelsSource`'s candles. */
  levels?: { price: number; title: string }[];
  levelsSource?: CandleSource;
}

const REFRESH_MS = 20_000;
/** Bars on screen when a chart first opens. */
const INITIAL_BARS = 110;
const SOURCES: CandleSource[] = ['binance', 'okx'];

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; at: number; bars: number }
  | { kind: 'failed'; message: string; at: number | null };

/** The chart draws times as UTC; shifting by the zone offset makes the axis read in local time. */
function localSeconds(ms: number): UTCTimestamp {
  return ((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;
}

/** Enough decimals to tell neighbouring prices apart, from BTC to sub-cent coins. */
function precisionFor(price: number): number {
  if (!(price > 0)) return 2;
  if (price >= 1000) return 1;
  if (price >= 1) return 3;
  return Math.min(10, Math.ceil(-Math.log10(price)) + 3);
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function KlineChart({ base, listed, onClose, initialSource = 'binance', levels, levelsSource }: Props) {
  const [wanted, setWanted] = useState<CandleSource>(initialSource);
  const [interval, setInterval_] = useState<Interval>('15m');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const symbols = useMemo(
    () => ({ binance: symbolFor('binance', base, listed.binance), okx: symbolFor('okx', base, listed.okx) }),
    [base, listed.binance, listed.okx],
  );
  // "Not listed there" is a finding, not a failure: fall back to the other exchange and say so.
  const source: CandleSource = symbols[wanted] ? wanted : wanted === 'binance' ? 'okx' : 'binance';
  const symbol = symbols[source];
  const fellBack = source !== wanted;

  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);

  // One chart for the life of the component; data and colours are applied to it.
  useEffect(() => {
    if (!holder.current) return;
    const c = createChart(holder.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontSize: 11 },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 3 },
      localization: { locale: 'zh-TW' },
      crosshair: { mode: 0 },
    });
    chart.current = c;
    candles.current = c.addSeries(CandlestickSeries, { borderVisible: false });
    volume.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    c.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    c.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

    const paint = () => {
      const up = cssVar('--gain-mark');
      const down = cssVar('--loss-mark');
      const rule = cssVar('--hairline');
      c.applyOptions({
        layout: { textColor: cssVar('--ink-2') },
        grid: { vertLines: { color: rule }, horzLines: { color: rule } },
        timeScale: { borderColor: cssVar('--rule') },
        rightPriceScale: { borderColor: cssVar('--rule') },
      });
      candles.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
    };
    paint();
    // Repaint when the reader flips the colour convention or the OS theme changes.
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-up'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', paint);

    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', paint);
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
    };
  }, []);

  // Levels come from one exchange's candles; on the other exchange's chart they would mislead.
  const shownLevels = levels && levelsSource === source ? levels : [];
  const levelKey = shownLevels.map((l) => `${l.title}:${l.price}`).join('|');
  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    const lines: IPriceLine[] = shownLevels.map((l) =>
      series.createPriceLine({
        price: l.price,
        title: l.title,
        color: cssVar('--ink-2'),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
      }),
    );
    return () => lines.forEach((line) => series.removePriceLine(line));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey]);

  useEffect(() => {
    if (!symbol) return;
    const ctrl = new AbortController();
    let first = true;
    let lastOk: number | null = null;
    setLoad({ kind: 'loading' });
    candles.current?.setData([]);
    volume.current?.setData([]);

    const draw = (bars: Candle[]) => {
      const up = cssVar('--gain-mark');
      const down = cssVar('--loss-mark');
      const precision = precisionFor(bars[bars.length - 1].close);
      candles.current?.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
      candles.current?.setData(
        bars.map((b) => ({ time: localSeconds(b.t), open: b.open, high: b.high, low: b.low, close: b.close })),
      );
      volume.current?.setData(
        // Hex alpha 66 = 40%: volume is context, not the subject.
        bars.map((b) => ({ time: localSeconds(b.t), value: b.turnover, color: `${b.close >= b.open ? up : down}66` })),
      );
      if (first) {
        chart.current?.timeScale().setVisibleLogicalRange({ from: bars.length - INITIAL_BARS, to: bars.length + 3 });
        first = false;
      }
    };

    const run = async () => {
      if (document.hidden) return;
      try {
        const bars = await fetchCandles(source, symbol, interval, ctrl.signal);
        draw(bars);
        lastOk = Date.now();
        setLoad({ kind: 'ok', at: lastOk, bars: bars.length });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const message = err instanceof FetchError ? err.message : '未知錯誤';
        setLoad({ kind: 'failed', message, at: lastOk });
      }
    };
    void run();
    const timer = window.setInterval(run, REFRESH_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [source, symbol, interval]);

  return (
    <div className="kline">
      <div className="kline-head">
        <strong>
          {base} <span className="muted">{symbol ? `${SOURCE_NAME[source]} ${symbol}` : ''}</span>
        </strong>
        <div className="kline-controls">
          <div className="seg is-small" role="group" aria-label="K 線週期">
            {INTERVALS.map((i) => (
              <button key={i.id} type="button" aria-pressed={interval === i.id} onClick={() => setInterval_(i.id)}>
                {i.label}
              </button>
            ))}
          </div>
          <div className="seg is-small" role="group" aria-label="K 線資料來源">
            {SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={source === s}
                disabled={!symbols[s]}
                title={symbols[s] ? undefined : `${SOURCE_NAME[s]} 沒有這個合約`}
                onClick={() => setWanted(s)}
              >
                {SOURCE_NAME[s]}
              </button>
            ))}
          </div>
          <button type="button" className="kline-close" aria-label="關閉 K 線" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {fellBack && symbol && (
        <p className="kline-note">
          {SOURCE_NAME[wanted]}沒有 {base} 的 USDT 永續合約，以下是 {SOURCE_NAME[source]} 的 K 線。
        </p>
      )}
      {!symbol && <p className="alert is-warn">幣安和 OKX 都沒有 {base} 的 USDT 永續合約。</p>}
      {load.kind === 'failed' && (
        <p className="alert" role="alert">
          <strong>
            {SOURCE_NAME[source]} K 線抓取失敗{load.at !== null ? `，圖上停在 ${fmtClock(load.at)}` : ''}。
          </strong>{' '}
          {load.message}
        </p>
      )}

      <div
        className={load.kind === 'failed' && load.at !== null ? 'kline-plot is-dim' : 'kline-plot'}
        ref={holder}
        role="img"
        aria-label={`${base} K 線圖`}
      />

      <p className="kline-foot muted">
        {load.kind === 'loading' && '載入中…'}
        {load.kind === 'ok' && `${load.bars} 根 K 棒，更新於 ${fmtClock(load.at)}，每 20 秒重抓。時間為本機時區，下方為成交額。`}
      </p>
    </div>
  );
}
