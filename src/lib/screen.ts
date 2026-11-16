// The screener: a set of conditions applied to every contract on the board.
// The conditions are the backtest engine's own (`fires`), so a contract that
// matches here is exactly a contract that would fire in a backtest or tracker.

import { fires, judgeable, type Features, type Params, type Side } from '../../backtest/engine';
import type { Cell, Horizon, Metrics, Ticker } from '../types';
import { excessOver } from './metrics';

/** The conditions and which side to look for; holding period and fee belong to a tracker. */
export type Conditions = Omit<Params, 'hold' | 'feePct'>;
export type SideChoice = Side | 'both';

export interface Screen {
  side: SideChoice;
  conditions: Conditions;
}

export const DEFAULT_SCREEN: Screen = {
  side: 'both',
  conditions: {
    useRet: true,
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
  },
};

const HORIZONS: Horizon[] = ['1h', '4h', '24h'];

export const sidesOf = (choice: SideChoice): Side[] => (choice === 'both' ? ['long', 'short'] : [choice]);

const value = (cell: Cell | undefined): number => (cell?.kind === 'ok' ? cell.value : NaN);

/** The engine's view of a contract, built from the board's live metrics. */
export function toFeatures(m: Metrics | undefined, btc: Metrics | undefined): Features {
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
  };
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

export function runScreen(screen: Screen, top: Ticker[], metrics: Record<string, Metrics>): ScreenResult {
  const params: Params = { ...screen.conditions, hold: 1, feePct: 0 };
  const btcSymbol = top.find((t) => t.base === 'BTC')?.symbol;
  const btc = btcSymbol ? metrics[btcSymbol] : undefined;
  const result: ScreenResult = { matches: [], judged: 0, pending: 0, missing: 0 };
  for (const ticker of top) {
    const m = metrics[ticker.symbol];
    const f = toFeatures(m, btc);
    if (!judgeable(f, params)) {
      const cells = neededCells(screen.conditions, m, btc);
      if (cells.some((c) => !c || c.kind === 'pending')) result.pending++;
      else result.missing++;
      continue;
    }
    result.judged++;
    for (const side of sidesOf(screen.side)) {
      if (fires(f, params, side)) result.matches.push({ ticker, side, features: f });
    }
  }
  return result;
}

const num = (v: number) => String(Number(v.toFixed(4)));

/** Plain-language list of the conditions, as the long side reads them. */
export function describe(screen: Screen): string[] {
  const c = screen.conditions;
  const both = screen.side === 'both';
  const out: string[] = [];
  if (c.useRet) out.push(both ? `15 分鐘漲跌幅 ≥ ${num(c.retMin)}%（做多看漲、做空看跌）` : screen.side === 'long' ? `15 分鐘漲幅 ≥ ${num(c.retMin)}%` : `15 分鐘跌幅 ≥ ${num(c.retMin)}%`);
  if (c.useRvol) out.push(`RVOL ≥ ${num(c.rvolMin)}×`);
  if (c.useTaker) {
    const long = `買賣比 ≥ ${num(c.takerMin)}`;
    const short = `買賣比 ≤ ${(1 / c.takerMin).toFixed(2)}`;
    out.push(both ? `${long}（做多）／${short}（做空）` : screen.side === 'long' ? long : short);
  }
  if (c.useOi) out.push(`OI 15 分鐘增加 ≥ ${num(c.oiMin)}%`);
  if (c.useRs) {
    const long = `${c.rsHorizon} 漲幅超過 BTC ≥ ${num(c.rsMin)} 個百分點`;
    const short = `${c.rsHorizon} 漲幅落後 BTC ≥ ${num(c.rsMin)} 個百分點`;
    out.push(both ? `${long}（做多）／落後（做空）` : screen.side === 'long' ? long : short);
  }
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
  const c = r.conditions as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return null;
  if (r.side !== 'long' && r.side !== 'short' && r.side !== 'both') return null;
  const bool = (k: string) => typeof c[k] === 'boolean';
  const pos = (k: string) => typeof c[k] === 'number' && Number.isFinite(c[k]) && (c[k] as number) >= 0;
  const flags = ['useRet', 'useRvol', 'useTaker', 'useOi', 'useRs'];
  const numbers = ['retMin', 'rvolMin', 'takerMin', 'oiMin', 'rsMin'];
  if (!flags.every(bool) || !numbers.every(pos) || !isHorizon(c.rsHorizon)) return null;
  if ((c.takerMin as number) < 1) return null;
  const conditions = Object.fromEntries([...flags, ...numbers, 'rsHorizon'].map((k) => [k, c[k]])) as unknown as Conditions;
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
