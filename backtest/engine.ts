// Pure backtest logic: features per bar, signals, trades and statistics.
// The definitions follow backtest/README.md; the metrics match src/lib/metrics.ts
// (tests/backtest.test.ts checks the RVOL here against the site's own function).

import { BAR_MS, BASELINE_BARS, MIN_BASELINE } from '../src/lib/metrics';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One contract's bars, oldest first, exactly as the daily CSV files hold them. */
export interface Row {
  t: number;
  open: number;
  close: number;
  turnover: number;
  /** Open interest in coins at the bar's close; NaN when the exchange had none. */
  oi: number;
  takerBuy: number;
  takerSell: number;
  /** Funding rate settled at this bar's open; NaN when there was no settlement. */
  funding: number;
}

/** What is known about a bar at its close. NaN means "not computable". */
export interface Features {
  ret15: number;
  rvol: number;
  taker: number;
  oi15: number;
}

export type Side = 'long' | 'short';
export type SignalName = 'base' | 'full';

/** Everything about a test that can be chosen. */
export interface Params {
  /** Minimum size of the signal bar's move, in percent (long: at least +x, short: at most −x). */
  retMin: number;
  /** Minimum relative volume of the signal bar. */
  rvolMin: number;
  /** Require taker flow to agree: long needs buy/sell ≥ takerMin, short needs ≤ 1/takerMin. */
  useTaker: boolean;
  takerMin: number;
  /** Require open interest to rise by at least oiMin percent across the signal bar. */
  useOi: boolean;
  oiMin: number;
  /** Holding period in 15-minute bars. */
  hold: number;
  /** Round-trip fee, in percent. */
  feePct: number;
}

export interface Trade {
  instId: string;
  side: Side;
  /** Open time of the signal bar. */
  signalTime: number;
  /** Entry time: the open of the bar after the signal bar. */
  entryTime: number;
  /** Signed return before costs, in percent, for each holding period in bars. */
  gross: Record<number, number>;
  /** Signed return after fees and funding, in percent. */
  net: Record<number, number>;
}

// ---------- the pre-registered tests (backtest/README.md); do not tune these ----------

/** Round-trip taker fee, in percent. */
export const FEE_PCT = 0.1;
export const PRIMARY_HOLD = 4;
/** Holding periods reported by the registered tests; the first is the primary one. */
export const HOLDS = [4, 1, 16] as const;

export const REGISTERED: Record<SignalName, Params> = {
  base: { retMin: 0.5, rvolMin: 2, useTaker: false, takerMin: 1.25, useOi: false, oiMin: 0.3, hold: PRIMARY_HOLD, feePct: FEE_PCT },
  full: { retMin: 0.5, rvolMin: 2, useTaker: true, takerMin: 1.25, useOi: true, oiMin: 0.3, hold: PRIMARY_HOLD, feePct: FEE_PCT },
};

// ---------- features ----------

/** Insert into / remove from a sorted array. */
function insert(sorted: number[], v: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, v);
}
function remove(sorted: number[], v: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (sorted[lo] === v) sorted.splice(lo, 1);
}

/**
 * Features for every bar. RVOL uses the up-to-288 bars before the bar (by
 * position in the feed, as the site does), dropping zero-turnover bars.
 */
export function computeFeatures(rows: Row[]): Features[] {
  const out: Features[] = [];
  const window: number[] = []; // positive turnovers currently in the baseline, sorted
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Slide the baseline: bar i-1 enters, bar i-1-BASELINE_BARS leaves.
    if (i >= 1 && rows[i - 1].turnover > 0) insert(window, rows[i - 1].turnover);
    const leaving = i - 1 - BASELINE_BARS;
    if (leaving >= 0 && rows[leaving].turnover > 0) remove(window, rows[leaving].turnover);

    let rvol = NaN;
    if (window.length >= MIN_BASELINE) {
      const mid = window.length >> 1;
      const median = window.length % 2 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
      if (median > 0) rvol = r.turnover / median;
    }

    const prev = rows[i - 1];
    // OI change needs the snapshot exactly one bar earlier; a gap in the feed gives no value.
    const oi15 = prev && prev.t === r.t - BAR_MS && prev.oi > 0 && r.oi > 0 ? (r.oi / prev.oi - 1) * 100 : NaN;

    out.push({
      ret15: r.open > 0 ? (r.close / r.open - 1) * 100 : NaN,
      rvol,
      taker: r.takerBuy >= 0 && r.takerSell > 0 ? r.takerBuy / r.takerSell : NaN,
      oi15,
    });
  }
  return out;
}

/** Whether a bar fires the signal on `side`. A NaN feature never satisfies a condition. */
export function fires(f: Features, p: Params, side: Side): boolean {
  if (!(f.rvol >= p.rvolMin)) return false;
  if (!(side === 'long' ? f.ret15 >= p.retMin : f.ret15 <= -p.retMin)) return false;
  if (p.useTaker && !(side === 'long' ? f.taker >= p.takerMin : f.taker <= 1 / p.takerMin)) return false;
  if (p.useOi && !(f.oi15 >= p.oiMin)) return false;
  return true;
}

// ---------- trades ----------

/** Raw (long-side, before costs) return in percent from the open of bar `i` to the open `hold` bars later. */
function forward(rows: Row[], i: number, hold: number): number {
  const entry = rows[i];
  const exit = rows[i + hold];
  // Both bars must exist and sit exactly `hold` bars apart, or the path had a gap.
  if (!entry || !exit || exit.t !== entry.t + hold * BAR_MS || !(entry.open > 0)) return NaN;
  return (exit.open / entry.open - 1) * 100;
}

/** Funding paid by a long, in percent, for settlements in (entry, exit]. */
function fundingPaid(rows: Row[], i: number, hold: number): number {
  let sum = 0;
  for (let k = i + 1; k <= i + hold && k < rows.length; k++) {
    if (Number.isFinite(rows[k].funding)) sum += rows[k].funding * 100;
  }
  return sum;
}

/**
 * Trades for one contract and one side over signal bars in [from, to). A
 * signal that fires while a trade from an earlier signal is still open (for
 * `p.hold` bars) is skipped. Returns are also reported for any extra holding
 * periods in `holds`.
 */
export function findTrades(
  instId: string,
  rows: Row[],
  features: Features[],
  p: Params,
  side: Side,
  from: number,
  to: number,
  holds: readonly number[] = [p.hold],
): Trade[] {
  const trades: Trade[] = [];
  const sign = side === 'long' ? 1 : -1;
  let busyUntil = -1; // index of the bar at whose open the open trade exits
  for (let i = 0; i < rows.length - 1; i++) {
    const t = rows[i].t;
    if (t < from || t >= to || !fires(features[i], p, side)) continue;
    const entry = i + 1;
    if (entry < busyUntil) continue;
    // The entry bar must be the very next bar.
    if (rows[entry].t !== t + BAR_MS) continue;
    const gross: Record<number, number> = {};
    const net: Record<number, number> = {};
    for (const hold of holds) {
      const raw = forward(rows, entry, hold);
      gross[hold] = sign * raw;
      net[hold] = sign * raw - p.feePct - sign * fundingPaid(rows, entry, hold);
    }
    if (!Number.isFinite(gross[p.hold])) continue;
    trades.push({ instId, side, signalTime: t, entryTime: rows[entry].t, gross, net });
    busyUntil = entry + p.hold;
  }
  return trades;
}

/** Mean raw (long-side) forward return in percent over every bar that could be an entry in [from, to). */
export function unconditional(all: Row[][], hold: number, from: number, to: number): { mean: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const rows of all) {
    for (let i = 1; i < rows.length; i++) {
      const signal = rows[i - 1].t;
      if (signal < from || signal >= to) continue;
      const r = forward(rows, i, hold);
      if (Number.isFinite(r)) {
        sum += r;
        n++;
      }
    }
  }
  return { mean: n ? sum / n : NaN, n };
}

// ---------- statistics ----------

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Deterministic PRNG (mulberry32) so a bootstrap gives the same answer every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% confidence interval for the mean, resampling whole clusters (entry
 * days) with replacement. Trades entered on the same day move together, so
 * resampling trades one by one would overstate the precision.
 */
export function clusterBootstrap(
  values: number[],
  clusters: number[],
  reps = 2000,
  seed = 20261115,
): { lo: number; hi: number; clusters: number } {
  const groups = new Map<number, { sum: number; n: number }>();
  values.forEach((v, i) => {
    const g = groups.get(clusters[i]) ?? { sum: 0, n: 0 };
    g.sum += v;
    g.n++;
    groups.set(clusters[i], g);
  });
  const list = [...groups.values()];
  if (list.length < 2) return { lo: NaN, hi: NaN, clusters: list.length };
  const rand = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < list.length; k++) {
      const g = list[Math.floor(rand() * list.length)];
      sum += g.sum;
      n += g.n;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * reps)], hi: means[Math.ceil(0.975 * reps) - 1], clusters: list.length };
}

export type Verdict = '有效' | '無效' | '無統計意義';

export interface Summary {
  n: number;
  netMean: number;
  netMedian: number;
  grossMean: number;
  winRate: number;
  ci: { lo: number; hi: number; clusters: number };
  firstHalf: { n: number; netMean: number };
  secondHalf: { n: number; netMean: number };
  /** Share of trades from the single most frequent contract. */
  topShare: number;
  topInst: string;
  verdict: Verdict;
}

/** Summary and pre-registered verdict for one signal at one holding period. */
export function summarise(trades: Trade[], hold: number, from: number, to: number): Summary {
  const valid = trades.filter((t) => Number.isFinite(t.net[hold]));
  const net = valid.map((t) => t.net[hold]);
  const days = valid.map((t) => Math.floor(t.entryTime / DAY_MS));
  const half = from + (to - from) / 2;
  const first = valid.filter((t) => t.signalTime < half).map((t) => t.net[hold]);
  const second = valid.filter((t) => t.signalTime >= half).map((t) => t.net[hold]);
  const counts = new Map<string, number>();
  for (const t of valid) counts.set(t.instId, (counts.get(t.instId) ?? 0) + 1);
  const [topInst, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const ci = clusterBootstrap(net, days);
  const netMean = mean(net);

  let verdict: Verdict;
  if (valid.length < 30) verdict = '無統計意義';
  else if (netMean > 0 && ci.lo > 0 && mean(first) > 0 && mean(second) > 0) verdict = '有效';
  else verdict = '無效';

  return {
    n: valid.length,
    netMean,
    netMedian: median(net),
    grossMean: mean(valid.map((t) => t.gross[hold])),
    winRate: valid.length ? net.filter((v) => v > 0).length / valid.length : NaN,
    ci,
    firstHalf: { n: first.length, netMean: mean(first) },
    secondHalf: { n: second.length, netMean: mean(second) },
    topShare: valid.length ? topCount / valid.length : NaN,
    topInst,
    verdict,
  };
}
