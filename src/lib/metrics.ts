import type { Bar, Cell, OiPoint, TakerPoint, Ticker } from '../types';

export const BAR_MS = 15 * 60 * 1000;
/** RVOL baseline: the 3 days of bars before the bar being measured. */
export const BASELINE_BARS = 288;
/** Fewer baseline bars than this (12 hours) and RVOL is not shown. */
export const MIN_BASELINE = 48;
export const TOP_N = 50;

const OK = (value: number): Cell => ({ kind: 'ok', value });
const INSUFFICIENT: Cell = { kind: 'insufficient' };

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Open time of the 15-minute bar that most recently closed, by the clock. */
export function lastClosedBarTime(now: number): number {
  return Math.floor(now / BAR_MS) * BAR_MS - BAR_MS;
}

/** The bar opening at `barTime`, if the feed has it. */
export function barAt(bars: Bar[], barTime: number): Bar | undefined {
  return bars.find((b) => b.t === barTime);
}

/**
 * Relative volume: turnover of the bar at `barTime` divided by the median
 * turnover of the 3 days of bars before it.
 */
export function computeRvol(bars: Bar[], barTime: number): Cell {
  const bar = barAt(bars, barTime);
  if (!bar) return INSUFFICIENT;
  // Zero-volume bars are halts or padding from the data source, not trading.
  const baseline = bars
    .filter((b) => b.t < barTime)
    .sort((a, b) => a.t - b.t)
    .slice(-BASELINE_BARS)
    .map((b) => b.turnover)
    .filter((v) => v > 0);
  if (baseline.length < MIN_BASELINE) return INSUFFICIENT;
  const base = median(baseline);
  return base > 0 ? OK(bar.turnover / base) : INSUFFICIENT;
}

/** The bar's own price change, open to close, in percent. */
export function computeReturn(bars: Bar[], barTime: number): Cell {
  const bar = barAt(bars, barTime);
  return bar && bar.open > 0 ? OK((bar.close / bar.open - 1) * 100) : INSUFFICIENT;
}

/** Taker buy turnover over taker sell turnover, from a buy/sell pair. */
export function takerRatio(buy: number, sell: number): Cell {
  // A bar with no taker selling has no meaningful ratio.
  return buy >= 0 && sell > 0 ? OK(buy / sell) : INSUFFICIENT;
}

/** Taker ratio from candles that carry the taker-buy split. */
export function takerFromBars(bars: Bar[], barTime: number): Cell {
  const bar = barAt(bars, barTime);
  if (!bar || bar.takerBuy === null) return INSUFFICIENT;
  return takerRatio(bar.takerBuy, bar.turnover - bar.takerBuy);
}

/** Taker ratio from a separate taker-volume series. */
export function takerFromPoints(points: TakerPoint[], barTime: number): Cell {
  const p = points.find((x) => x.t === barTime);
  return p ? takerRatio(p.buy, p.sell) : INSUFFICIENT;
}

/**
 * The open-interest snapshot to measure from: the one at the bar's close, or,
 * while the exchange has not published that yet, the one a bar earlier.
 * Anything older is too stale to describe the bar.
 */
export function oiAnchor(points: OiPoint[], closeTime: number): OiPoint | undefined {
  return points.find((p) => p.t === closeTime) ?? points.find((p) => p.t === closeTime - BAR_MS);
}

/**
 * Percent change in open interest over the `spanMs` ending at the anchor
 * snapshot. Needs a snapshot at both ends; a missing one is "insufficient",
 * never a guess.
 */
export function computeOiChange(points: OiPoint[], closeTime: number, spanMs: number): Cell {
  const end = oiAnchor(points, closeTime);
  if (!end) return INSUFFICIENT;
  const start = points.find((p) => p.t === end.t - spanMs);
  return start && start.oi > 0 ? OK((end.oi / start.oi - 1) * 100) : INSUFFICIENT;
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
