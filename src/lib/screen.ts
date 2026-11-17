// The screener: a set of conditions applied to every contract on the board.
// The conditions are the backtest engine's own (`fires`), so a contract that
// matches here is exactly a contract that would fire in a backtest or tracker.
// Pure functions only, so this can move to a backend unchanged.

import { breakoutSettings, fires, judgeable, type Features, type Params, type Side, type SignalState } from '../../backtest/engine';
import type { Bar, Cell, Horizon, Metrics, Ticker } from '../types';
import { breakoutSeries, DEFAULT_BREAKOUT, liveBreakout, type BreakoutBar, type LiveBreakout, type SideBreakout } from './breakout';
import { excessOver } from './metrics';

/** The conditions and which side to look for; holding period and fee belong to a tracker. */
export type Conditions = Omit<Params, 'hold' | 'feePct'>;
export type SideChoice = Side | 'both';

export interface Screen {
  side: SideChoice;
  conditions: Conditions;
}

/** Fields added after the first release; saved settings without them get these. */
const BREAKOUT_DEFAULTS = {
  useBreakout: false,
  breakoutState: 'fresh' as SignalState,
  rangeBars: DEFAULT_BREAKOUT.rangeBars,
  extendAtr: DEFAULT_BREAKOUT.extendAtr,
};

/** The momentum radar: a fresh breakout with volume, ahead of (or behind) BTC. */
export const DEFAULT_SCREEN: Screen = {
  side: 'both',
  conditions: {
    useRet: false,
    retMin: 0.5,
    useRvol: true,
    rvolMin: 2,
    useTaker: false,
    takerMin: 1.25,
    useOi: false,
    oiMin: 0.3,
    useRs: true,
    rsHorizon: '4h',
    rsMin: 1,
    ...BREAKOUT_DEFAULTS,
    useBreakout: true,
  },
};

const HORIZONS: Horizon[] = ['1h', '4h', '24h'];
export const SIGNAL_STATES: SignalState[] = ['fresh', 'holding', 'extended', 'near'];

export const sidesOf = (choice: SideChoice): Side[] => (choice === 'both' ? ['long', 'short'] : [choice]);
export const dirOf = (side: Side) => (side === 'long' ? 'up' : 'down');

const value = (cell: Cell | undefined): number => (cell?.kind === 'ok' ? cell.value : NaN);

/** The engine's view of a contract, built from the board's live metrics. */
export function toFeatures(m: Metrics | undefined, btc: Metrics | undefined, breakout: BreakoutBar | null): Features {
  const lookback = { '1h': NaN, '4h': NaN, '24h': NaN } as Record<Horizon, number>;
  const excess = { '1h': NaN, '4h': NaN, '24h': NaN } as Record<Horizon, number>;
  for (const h of HORIZONS) {
    lookback[h] = value(m?.lookback[h]);
    excess[h] = excessOver(m?.lookback[h], btc?.lookback[h]) ?? NaN;
  }
  return {
    ret15: value(m?.ret15),
    rvol: value(m?.rvol),
    taker: value(m?.taker),
    oi15: value(m?.oi15),
    lookback,
    excess,
    turnover24: NaN,
    breakout,
  };
}

/**
 * Breakout state of every contract at the bar its metrics describe. Only
 * closed bars count: the bar still forming is left out.
 */
export function breakoutAtBar(
  top: Ticker[],
  metrics: Record<string, Metrics>,
  bars: Record<string, Bar[]>,
  conditions: Pick<Conditions, 'rangeBars' | 'extendAtr'>,
): Record<string, { bar: BreakoutBar; closed: Bar[] } | undefined> {
  const settings = breakoutSettings(conditions);
  const out: Record<string, { bar: BreakoutBar; closed: Bar[] } | undefined> = {};
  for (const { symbol } of top) {
    const at = metrics[symbol]?.barTime;
    const series = bars[symbol];
    if (at === undefined || !series) continue;
    const closed = series.filter((b) => b.t <= at).sort((a, b) => a.t - b.t);
    const last = closed[closed.length - 1];
    // The metrics describe bar `at`; without that very bar the state would be for another time.
    if (!last || last.t !== at) continue;
    const all = breakoutSeries(closed, settings);
    out[symbol] = { bar: all[all.length - 1], closed };
  }
  return out;
}

/** The cells a set of conditions reads, so a missing value can be explained. */
function neededCells(c: Conditions, m: Metrics | undefined, btc: Metrics | undefined): (Cell | undefined)[] {
  const cells: (Cell | undefined)[] = [];
  if (c.useRet) cells.push(m?.ret15);
  if (c.useRvol) cells.push(m?.rvol);
  if (c.useTaker) cells.push(m?.taker);
  if (c.useOi) cells.push(m?.oi15);
  if (c.useRs) cells.push(m?.lookback[c.rsHorizon], btc?.lookback[c.rsHorizon]);
  return cells;
}

export interface Match {
  ticker: Ticker;
  side: Side;
  features: Features;
  /** The breakout in the match's direction at the last closed bar, and what the live price adds. */
  breakout: SideBreakout | null;
  live: LiveBreakout | null;
}

export interface ScreenResult {
  matches: Match[];
  /** Contracts every condition could be checked on. */
  judged: number;
  /** Contracts with a needed value still loading. */
  pending: number;
  /** Contracts with a needed value the exchange could not supply, or whose request failed. */
  missing: number;
}

export function runScreen(
  screen: Screen,
  top: Ticker[],
  metrics: Record<string, Metrics>,
  breakouts: Record<string, { bar: BreakoutBar; closed: Bar[] } | undefined>,
): ScreenResult {
  const params: Params = { ...screen.conditions, hold: 1, feePct: 0 };
  const settings = breakoutSettings(screen.conditions);
  const btcSymbol = top.find((t) => t.base === 'BTC')?.symbol;
  const btc = btcSymbol ? metrics[btcSymbol] : undefined;
  const result: ScreenResult = { matches: [], judged: 0, pending: 0, missing: 0 };
  for (const ticker of top) {
    const m = metrics[ticker.symbol];
    const b = breakouts[ticker.symbol];
    const f = toFeatures(m, btc, b?.bar ?? null);
    if (!judgeable(f, params)) {
      const cells = neededCells(screen.conditions, m, btc);
      // Candles not loaded yet leave the breakout unknown for the same reason a metric is pending.
      const breakoutPending = screen.conditions.useBreakout && !b && (!m || m.rvol.kind === 'pending');
      if (breakoutPending || cells.some((c) => !c || c.kind === 'pending')) result.pending++;
      else result.missing++;
      continue;
    }
    result.judged++;
    for (const side of sidesOf(screen.side)) {
      if (!fires(f, params, side)) continue;
      const dir = dirOf(side);
      const own = b?.bar[dir] ?? null;
      const live = b && own ? liveBreakout(b.closed, own, dir, ticker.price, settings) : null;
      result.matches.push({ ticker, side, features: f, breakout: own, live });
    }
  }
  return result;
}

const num = (v: number) => String(Number(v.toFixed(4)));

const STATE_LABEL: Record<SignalState, [string, string]> = {
  fresh: ['剛突破區間高點', '剛跌破區間低點'],
  holding: ['突破後在突破位附近整理', '跌破後在跌破位附近整理'],
  extended: ['突破後已延伸', '跌破後已延伸'],
  near: ['接近區間高點', '接近區間低點'],
};

/** Plain-language list of the conditions. */
export function describe(screen: Screen): string[] {
  const c = screen.conditions;
  const both = screen.side === 'both';
  const pick = (long: string, short: string) => (both ? `${long}（做多）／${short}（做空）` : screen.side === 'long' ? long : short);
  const out: string[] = [];
  if (c.useBreakout) {
    const [long, short] = STATE_LABEL[c.breakoutState];
    out.push(`${pick(long, short)}，區間為前 ${c.rangeBars} 根 15 分鐘 K 棒，離突破位超過 ${num(c.extendAtr)} ATR 算延伸`);
  }
  if (c.useRet) out.push(pick(`15 分鐘漲幅 ≥ ${num(c.retMin)}%`, `15 分鐘跌幅 ≥ ${num(c.retMin)}%`));
  if (c.useRvol) out.push(`RVOL ≥ ${num(c.rvolMin)}×`);
  if (c.useTaker) out.push(pick(`買賣比 ≥ ${num(c.takerMin)}`, `買賣比 ≤ ${(1 / c.takerMin).toFixed(2)}`));
  if (c.useOi) out.push(`OI 15 分鐘增加 ≥ ${num(c.oiMin)}%`);
  if (c.useRs) out.push(pick(`${c.rsHorizon} 漲幅超過 BTC ≥ ${num(c.rsMin)} 個百分點`, `${c.rsHorizon} 漲幅落後 BTC ≥ ${num(c.rsMin)} 個百分點`));
  return out;
}

// ---------- persistence and validation ----------

const KEY = 'screen';

function isHorizon(v: unknown): v is Horizon {
  return v === '1h' || v === '4h' || v === '24h';
}

/** Validate an untrusted object as a Screen; null when anything is off. */
export function parseScreen(raw: unknown): Screen | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const given = r.conditions as Record<string, unknown> | undefined;
  if (!given || typeof given !== 'object') return null;
  if (r.side !== 'long' && r.side !== 'short' && r.side !== 'both') return null;
  const c = { ...BREAKOUT_DEFAULTS, ...given } as Record<string, unknown>;
  const bool = (k: string) => typeof c[k] === 'boolean';
  const pos = (k: string) => typeof c[k] === 'number' && Number.isFinite(c[k]) && (c[k] as number) >= 0;
  const flags = ['useRet', 'useRvol', 'useTaker', 'useOi', 'useRs', 'useBreakout'];
  const numbers = ['retMin', 'rvolMin', 'takerMin', 'oiMin', 'rsMin', 'extendAtr'];
  if (!flags.every(bool) || !numbers.every(pos) || !isHorizon(c.rsHorizon)) return null;
  if ((c.takerMin as number) < 1) return null;
  if (!SIGNAL_STATES.includes(c.breakoutState as SignalState)) return null;
  const range = c.rangeBars;
  if (typeof range !== 'number' || !Number.isInteger(range) || range < 5 || range > 96) return null;
  const keys = [...flags, ...numbers, 'rsHorizon', 'breakoutState', 'rangeBars'];
  const conditions = Object.fromEntries(keys.map((k) => [k, c[k]])) as unknown as Conditions;
  return { side: r.side, conditions };
}

export function loadScreen(): Screen {
  try {
    const saved = parseScreen(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    return saved ?? DEFAULT_SCREEN;
  } catch {
    return DEFAULT_SCREEN;
  }
}

export function saveScreen(screen: Screen) {
  try {
    localStorage.setItem(KEY, JSON.stringify(screen));
  } catch {
    /* private mode: the settings last for this visit only */
  }
}
