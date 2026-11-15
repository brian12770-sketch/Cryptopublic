import { useEffect, useMemo, useRef, useState } from 'react';
import type { Adapter, HeatState, HourBar, Ticker } from '../types';
import { FetchError } from './http';
import { computeHeat, HOUR_MS, pool, topByTurnover } from './heat';

/** Poll interval for an exchange whose panel is not on screen. */
const BACKGROUND_POLL_MS = 60_000;
/** Wait this long after the hour turns so the exchange has closed the bar. */
const BAR_SETTLE_MS = 20_000;
const KLINE_RETRY_MS = 60_000;
const KLINE_CONCURRENCY = 3;

export type Link = 'connecting' | 'live' | 'stale' | 'down';

export interface ExchangeData {
  adapter: Adapter;
  /** Top contracts by 24h turnover, largest first. */
  top: Ticker[];
  /** Count of USDT perpetuals the exchange lists. */
  listed: number;
  lastOk: number | null;
  error: string | null;
  heat: Record<string, HeatState>;
  /** Open time of the hourly bar the heat ratios describe, when known. */
  heatBarTime: number | null;
}

interface BarCache {
  hourKey: number;
  bars: HourBar[] | null;
  error: string | null;
  failedAt: number;
}

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

export function useExchange(adapter: Adapter, visible: boolean): ExchangeData {
  const [top, setTop] = useState<Ticker[]>([]);
  const [listed, setListed] = useState(0);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heat, setHeat] = useState<Record<string, HeatState>>({});

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const topRef = useRef<Ticker[]>([]);
  const cache = useRef(new Map<string, BarCache>());
  const inflight = useRef(new Set<string>());

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

  // Hourly candles for the volume-anomaly ratio.
  useEffect(() => {
    const ctrl = new AbortController();

    const publish = () => {
      const now = Date.now();
      const next: Record<string, HeatState> = {};
      for (const t of topRef.current) {
        const entry = cache.current.get(t.symbol);
        if (!entry || (entry.bars === null && entry.error === null)) {
          next[t.symbol] = { kind: 'pending' };
        } else if (entry.bars === null) {
          next[t.symbol] = { kind: 'failed', message: entry.error ?? '抓取失敗' };
        } else {
          const h = computeHeat(entry.bars, now);
          next[t.symbol] = h ? { kind: 'ok', heat: h } : { kind: 'insufficient' };
        }
      }
      setHeat(next);
    };

    const refresh = async () => {
      if (document.hidden) return;
      const now = Date.now();
      const hourKey = Math.floor((now - BAR_SETTLE_MS) / HOUR_MS);
      const due = topRef.current
        .map((t) => t.symbol)
        .filter((symbol) => {
          if (inflight.current.has(symbol)) return false;
          const entry = cache.current.get(symbol);
          if (!entry) return true;
          if (entry.bars === null) return now - entry.failedAt > KLINE_RETRY_MS;
          return entry.hourKey !== hourKey;
        });
      if (due.length === 0) return;
      for (const s of due) inflight.current.add(s);
      await pool(due, KLINE_CONCURRENCY, async (symbol) => {
        try {
          const bars = await adapter.fetchHourBars(symbol, ctrl.signal);
          cache.current.set(symbol, { hourKey, bars, error: null, failedAt: 0 });
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const previous = cache.current.get(symbol);
          // Keep the last good bars; computeHeat drops them once they go stale.
          cache.current.set(symbol, {
            hourKey: previous?.hourKey ?? -1,
            bars: previous?.bars ?? null,
            error: message(err),
            failedAt: Date.now(),
          });
        } finally {
          inflight.current.delete(symbol);
        }
        if (!ctrl.signal.aborted) publish();
      });
    };

    const loop = setInterval(() => {
      void refresh();
      publish();
    }, 10_000);
    // First run as soon as the first ticker response has arrived.
    const first = setInterval(() => {
      if (topRef.current.length > 0) {
        clearInterval(first);
        publish();
        void refresh();
      }
    }, 300);

    return () => {
      ctrl.abort();
      clearInterval(loop);
      clearInterval(first);
    };
  }, [adapter]);

  const heatBarTime = useMemo(() => {
    let latest: number | null = null;
    for (const state of Object.values(heat)) {
      if (state.kind === 'ok' && (latest === null || state.heat.barTime > latest)) latest = state.heat.barTime;
    }
    return latest;
  }, [heat]);

  return { adapter, top, listed, lastOk, error, heat, heatBarTime };
}
