import type { Heat, HourBar, Ticker } from '../types';

export const HOUR_MS = 60 * 60 * 1000;
/** Baseline window: the 7 days before the bar being measured. */
export const BASELINE_BARS = 168;
/** Fewer baseline bars than this (one day) and the ratio is not shown. */
export const MIN_BASELINE = 24;
export const TOP_N = 50;

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Volume anomaly: turnover of the last closed hour divided by the median hourly
 * turnover of the 7 days before it. Returns null when the baseline is too thin
 * to mean anything.
 */
export function computeHeat(bars: HourBar[], now: number): Heat | null {
  const closed = bars
    .filter((b) => b.t + HOUR_MS <= now)
    .sort((a, b) => a.t - b.t);
  if (closed.length === 0) return null;
  const last = closed[closed.length - 1];
  // A feed that stopped more than two hours ago must not look current.
  if (now - (last.t + HOUR_MS) > 2 * HOUR_MS) return null;
  // Zero-volume bars are halts or padding from the data source, not trading.
  const baseline = closed
    .slice(0, -1)
    .slice(-BASELINE_BARS)
    .map((b) => b.turnover)
    .filter((v) => v > 0);
  if (baseline.length < MIN_BASELINE) return null;
  const base = median(baseline);
  if (!(base > 0)) return null;
  return { ratio: last.turnover / base, barTime: last.t, baselineN: baseline.length };
}

/** The N contracts with the highest 24h turnover, largest first. */
export function topByTurnover(tickers: Ticker[], n = TOP_N): Ticker[] {
  return [...tickers].sort((a, b) => b.turnover24h - a.turnover24h).slice(0, n);
}

/** Run tasks with a concurrency cap; one failure never stops the others. */
export async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}
