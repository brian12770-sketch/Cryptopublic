import { useEffect, useRef, useState } from 'react';
import type { Adapter, Bar, Cell, Metrics, OiPoint, TakerPoint, Ticker } from '../types';
import { FetchError } from './http';
import {
  BAR_MS,
  barAt,
  computeLookback,
  computeOiChange,
  HORIZON_BARS,
  oiAnchor,
  computeReturn,
  computeRvol,
  lastClosedBarTime,
  pool,
  takerFromBars,
  takerFromPoints,
  topByTurnover,
} from './metrics';

/** Poll interval for an exchange whose panel is not on screen. */
const BACKGROUND_POLL_MS = 60_000;
/** Wait this long after a bar closes before asking for it. */
const SETTLE_MS = 15_000;
/** Statistics endpoints publish a bar late; ask again this often, this many times. */
const LAG_RETRY_MS = 45_000;
const LAG_TRIES = 5;
const ERROR_RETRY_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

export type Link = 'connecting' | 'live' | 'stale' | 'down';

export interface ExchangeData {
  adapter: Adapter;
  /** Top contracts by 24h turnover, largest first. */
  top: Ticker[];
  /** Count of USDT perpetuals the exchange lists. */
  listed: number;
  /** Every USDT perpetual the exchange lists; empty until it has answered. */
  symbols: ReadonlySet<string>;
  /** The 100 contracts with the most 24h turnover right now, best first. */
  ranked: string[];
  /** 15-minute candles per contract, as last fetched; may include the bar still forming. */
  bars: Record<string, Bar[]>;
  lastOk: number | null;
  error: string | null;
  metrics: Record<string, Metrics>;
  /** Open time of the 15-minute bar the metrics describe. */
  barTime: number | null;
}

/** One symbol's copy of one series (candles, open interest or taker volume). */
interface Entry<T> {
  data: T[] | null;
  /**
   * The last closed bar when `data` was fetched, or -1 without data. Bars up
   * to this one are final in `data`; a later bar in it was still forming.
   */
  dataFor: number;
  /** Bar the last request was made for. */
  barTime: number;
  /** Whether `data` already covers that bar. */
  fresh: boolean;
  tries: number;
  fetchedAt: number;
  error: string | null;
}

type Series<T> = Map<string, Entry<T>>;

const PENDING: Cell = { kind: 'pending' };
const INSUFFICIENT: Cell = { kind: 'insufficient' };

function message(err: unknown): string {
  if (err instanceof FetchError) return err.message;
  return err instanceof Error ? err.message : '未知錯誤';
}

export function linkOf(data: ExchangeData, now: number): Link {
  if (data.lastOk === null) return data.error ? 'down' : 'connecting';
  const age = now - data.lastOk;
  const fresh = Math.max(3 * data.adapter.pollMs, 12_000);
  if (age <= fresh) return 'live';
  return age <= 45_000 ? 'stale' : 'down';
}

/** A symbol needs a request when it has no data for this bar, or the last try failed or came back short. */
function isDue<T>(entry: Entry<T> | undefined, barTime: number, now: number): boolean {
  if (!entry || entry.barTime !== barTime) return true;
  if (entry.error) return now - entry.fetchedAt > ERROR_RETRY_MS;
  return !entry.fresh && entry.tries < LAG_TRIES && now - entry.fetchedAt > LAG_RETRY_MS;
}

/**
 * Turn a cached series into a cell describing bar `at`. A failed request
 * reads as failed; data fetched before `at` closed, or a series still catching
 * up with the `target` bar, reads as pending; only a series that has stopped
 * retrying can read as insufficient.
 */
function cellFrom<T>(entry: Entry<T> | undefined, at: number, target: number, compute: (data: T[]) => Cell): Cell {
  const failed = (message: string): Cell => ({ kind: 'failed', message });
  if (!entry || entry.data === null) return entry?.error ? failed(entry.error) : PENDING;
  // Data from before the bar closed holds only a partial copy of it.
  if (entry.dataFor < at) return entry.error ? failed(entry.error) : PENDING;
  const cell = compute(entry.data);
  if (cell.kind === 'insufficient') {
    if (entry.error) return failed(entry.error);
    if (entry.barTime !== target || (!entry.fresh && entry.tries < LAG_TRIES)) return PENDING;
  }
  return cell;
}

export function useExchange(adapter: Adapter, visible: boolean): ExchangeData {
  const [top, setTop] = useState<Ticker[]>([]);
  const [listed, setListed] = useState(0);
  const [symbols, setSymbols] = useState<ReadonlySet<string>>(() => new Set());
  const [ranked, setRanked] = useState<string[]>([]);
  const [barsBySymbol, setBarsBySymbol] = useState<Record<string, Bar[]>>({});
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [barTime, setBarTime] = useState<number | null>(null);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const topRef = useRef<Ticker[]>([]);
  const kick = useRef<() => void>(() => {});

  // Ticker polling. Slows down for off-screen panels and stops for hidden pages.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, visibleRef.current ? adapter.pollMs : BACKGROUND_POLL_MS);
    };
    const tick = async () => {
      if (document.hidden || running) return;
      running = true;
      try {
        const all = await adapter.fetchTickers(ctrl.signal);
        const ranked = topByTurnover(all);
        topRef.current = ranked;
        setTop(ranked);
        setListed(all.length);
        setRanked(topByTurnover(all, 100).map((t) => t.symbol));
        // Listings change rarely; keep the same Set unless the membership did.
        setSymbols((prev) => (prev.size === all.length && all.every((t) => prev.has(t.symbol)) ? prev : new Set(all.map((t) => t.symbol))));
        setLastOk(Date.now());
        setError(null);
      } catch (err) {
        if (!ctrl.signal.aborted) setError(message(err));
      } finally {
        running = false;
        if (!ctrl.signal.aborted) schedule();
      }
    };
    const now = () => {
      clearTimeout(timer);
      void tick();
    };
    const onVisibility = () => {
      if (!document.hidden) now();
    };

    kick.current = now;
    now();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      kick.current = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [adapter]);

  // A panel coming on screen should not wait out a background interval.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) kick.current();
    wasVisible.current = visible;
  }, [visible]);

  // 15-minute candles, open interest and taker volume, refreshed as each bar closes.
  useEffect(() => {
    const ctrl = new AbortController();
    const bars: Series<Bar> = new Map();
    const oi: Series<OiPoint> = new Map();
    const taker: Series<TakerPoint> = new Map();
    const busy = { bars: false, oi: false, taker: false };

    /** The bar to describe: the last one closed, once it has had time to settle. */
    const target = () => lastClosedBarTime(Date.now() - SETTLE_MS);

    const publish = () => {
      const bar = target();
      const next: Record<string, Metrics> = {};
      for (const { symbol } of topRef.current) {
        const b = bars.get(symbol);
        // Whether the candles on hand include a finished copy of the bar opening at `t`.
        const has = (t: number) => !!b?.data && b.dataFor >= t && barAt(b.data, t) !== undefined;
        // Right after a bar closes its candles are still on their way. Keep
        // describing the previous bar until they arrive, rather than going blank.
        // A failed request is not "on its way": that case reports the failure.
        const at = has(bar) ? bar : !b?.error && has(bar - BAR_MS) ? bar - BAR_MS : bar;
        const close = at + BAR_MS;
        const oiEntry = oi.get(symbol);
        next[symbol] = {
          barTime: at,
          rvol: cellFrom(b, at, bar, (d) => computeRvol(d, at)),
          ret15: cellFrom(b, at, bar, (d) => computeReturn(d, at)),
          taker: adapter.fetchTaker
            ? cellFrom(taker.get(symbol), at, bar, (d) => takerFromPoints(d, at))
            : cellFrom(b, at, bar, (d) => takerFromBars(d, at)),
          oi15: adapter.fetchOi ? cellFrom(oiEntry, at, bar, (d) => computeOiChange(d, close, BAR_MS)) : INSUFFICIENT,
          oi1h: adapter.fetchOi ? cellFrom(oiEntry, at, bar, (d) => computeOiChange(d, close, HOUR_MS)) : INSUFFICIENT,
          oiTime: oiAnchor(oiEntry?.data ?? [], close)?.t ?? null,
          lookback: {
            '1h': cellFrom(b, at, bar, (d) => computeLookback(d, at, HORIZON_BARS['1h'])),
            '4h': cellFrom(b, at, bar, (d) => computeLookback(d, at, HORIZON_BARS['4h'])),
            '24h': cellFrom(b, at, bar, (d) => computeLookback(d, at, HORIZON_BARS['24h'])),
          },
        };
      }
      setMetrics(next);
      setBarTime(bar);
      // Keep the same object while no series has changed, so work keyed on it is not redone.
      setBarsBySymbol((prev) => {
        const fresh: Record<string, Bar[]> = {};
        let changed = false;
        for (const { symbol } of topRef.current) {
          const data = bars.get(symbol)?.data;
          if (!data) continue;
          fresh[symbol] = data;
          if (prev[symbol] !== data) changed = true;
        }
        if (Object.keys(prev).length !== Object.keys(fresh).length) changed = true;
        return changed ? fresh : prev;
      });
    };

    async function refresh<T>(
      name: keyof typeof busy,
      series: Series<T>,
      limit: number,
      fetcher: ((symbol: string, signal: AbortSignal) => Promise<T[]>) | undefined,
      covers: (data: T[], bar: number) => boolean,
    ) {
      if (!fetcher || busy[name] || document.hidden) return;
      const bar = target();
      const due = topRef.current.map((t) => t.symbol).filter((s) => isDue(series.get(s), bar, Date.now()));
      if (due.length === 0) return;
      busy[name] = true;
      try {
        await pool(due, limit, async (symbol) => {
          const previous = series.get(symbol);
          const tries = previous && previous.barTime === bar ? previous.tries + 1 : 1;
          try {
            const data = await fetcher(symbol, ctrl.signal);
            series.set(symbol, { data, dataFor: bar, barTime: bar, fresh: covers(data, bar), tries, fetchedAt: Date.now(), error: null });
          } catch (err) {
            if (ctrl.signal.aborted) return;
            // Keep the last good data; the metric functions ignore bars that are not the target.
            series.set(symbol, {
              data: previous?.data ?? null,
              dataFor: previous?.dataFor ?? -1,
              barTime: bar,
              fresh: false,
              tries,
              fetchedAt: Date.now(),
              error: message(err),
            });
          }
          if (!ctrl.signal.aborted) publish();
        });
      } finally {
        busy[name] = false;
      }
    }

    const run = () => {
      const { concurrency } = adapter;
      void refresh('bars', bars, concurrency.bars, adapter.fetchBars.bind(adapter), (d, bar) => barAt(d, bar) !== undefined);
      void refresh('oi', oi, concurrency.stats, adapter.fetchOi?.bind(adapter), (d, bar) =>
        d.some((p) => p.t === bar + BAR_MS),
      );
      void refresh('taker', taker, concurrency.stats, adapter.fetchTaker?.bind(adapter), (d, bar) =>
        d.some((p) => p.t === bar),
      );
    };

    const loop = setInterval(() => {
      run();
      publish();
    }, 10_000);
    // First run as soon as the first ticker response has arrived.
    const first = setInterval(() => {
      if (topRef.current.length > 0) {
        clearInterval(first);
        publish();
        run();
      }
    }, 300);

    return () => {
      ctrl.abort();
      clearInterval(loop);
      clearInterval(first);
    };
  }, [adapter]);

  return { adapter, top, listed, symbols, ranked, bars: barsBySymbol, lastOk, error, metrics, barTime };
}
