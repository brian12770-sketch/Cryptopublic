// Breakout state of a contract, bar by bar, from closed 15-minute candles.
//
// Pure computation with no browser or network dependency, so the same code
// can run in the page, in the daily tracker job, and later in a backend.
//
// Definitions (long side; the short side mirrors them with the range low):
//   range      the highest high of the `rangeBars` closed bars before a bar
//   ATR        mean true range of the `atrBars` bars ending at that bar
//   trigger    a bar that closes above its range high while no breakout is
//              active. The range high becomes the breakout level and is
//              frozen, together with the ATR, until the breakout ends.
//   fresh      within `freshBars` bars of the trigger and no further than
//              `extendAtr` ATR beyond the level
//   holding    later than that, still beyond the level and within `extendAtr`
//   extended   more than `extendAtr` ATR beyond the level, at any time
//   failed     the bar that closes back inside the level; the breakout ends
//   near       no breakout, and the close is within `nearAtr` ATR of the level
// A breakout also ends `rangeBars` bars after its trigger, when the range has
// been rebuilt entirely from bars after the trigger; a close beyond that new
// range is a new trigger.

import { BAR_MS } from './metrics';

export interface BreakoutSettings {
  rangeBars: number;
  atrBars: number;
  freshBars: number;
  extendAtr: number;
  nearAtr: number;
}

/** Research parameters, not tuned. `rangeBars` and `extendAtr` can be changed on the page. */
export const DEFAULT_BREAKOUT: BreakoutSettings = { rangeBars: 20, atrBars: 14, freshBars: 1, extendAtr: 1.5, nearAtr: 0.5 };

export type BreakoutState = 'unknown' | 'none' | 'near' | 'fresh' | 'holding' | 'extended' | 'failed';
export type Direction = 'up' | 'down';

export interface SideBreakout {
  state: BreakoutState;
  /** The frozen breakout level while a breakout is active, else the current range edge. NaN when unknown. */
  level: number;
  /** ATR used for distances: frozen at the trigger while a breakout is active. */
  atr: number;
  /** Open time of the trigger bar; null without an active (or just failed) breakout. */
  triggerTime: number | null;
  /** Bars since the trigger bar (0 on the trigger bar itself). */
  barsSince: number;
  /**
   * Distance of the close from the level in ATR, positive in the breakout's
   * direction (above the high for up, below the low for down).
   */
  dist: number;
}

export interface BreakoutBar {
  up: SideBreakout;
  down: SideBreakout;
}

/** The fields this module reads; both the site's bars and the engine's rows have them. */
export interface Candle {
  t: number;
  high: number;
  low: number;
  close: number;
}

const UNKNOWN: SideBreakout = { state: 'unknown', level: NaN, atr: NaN, triggerTime: null, barsSince: 0, dist: NaN };

interface Episode {
  index: number;
  t: number;
  level: number;
  atr: number;
}

/** True when the `count` bars ending at `i` are consecutive 15-minute bars. */
function contiguous(bars: Candle[], i: number, count: number): boolean {
  const j = i - count + 1;
  return j >= 0 && bars[i].t - bars[j].t === (count - 1) * BAR_MS;
}

function trueRange(bars: Candle[], k: number): number {
  const b = bars[k];
  const prev = bars[k - 1].close;
  return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
}

/** Breakout state for every bar, oldest first. Bars must be sorted by time. */
export function breakoutSeries(bars: Candle[], s: BreakoutSettings = DEFAULT_BREAKOUT): BreakoutBar[] {
  const out: BreakoutBar[] = [];
  let up: Episode | null = null;
  let down: Episode | null = null;
  // The range needs rangeBars bars before this one; ATR needs one more for the previous close.
  const need = Math.max(s.rangeBars, s.atrBars) + 1;

  for (let i = 0; i < bars.length; i++) {
    if (!contiguous(bars, i, need)) {
      // A gap breaks the history: any active breakout can no longer be followed.
      up = null;
      down = null;
      out.push({ up: UNKNOWN, down: UNKNOWN });
      continue;
    }
    let high = -Infinity;
    let low = Infinity;
    for (let k = i - s.rangeBars; k < i; k++) {
      high = Math.max(high, bars[k].high);
      low = Math.min(low, bars[k].low);
    }
    let sum = 0;
    for (let k = i - s.atrBars + 1; k <= i; k++) sum += trueRange(bars, k);
    const atr = sum / s.atrBars;
    const close = bars[i].close;

    const step = (dir: Direction, active: Episode | null): [SideBreakout, Episode | null] => {
      const sign = dir === 'up' ? 1 : -1;
      const edge = dir === 'up' ? high : low;
      let ep = active;
      if (ep && i - ep.index >= s.rangeBars) ep = null; // the range has been rebuilt after the trigger
      if (ep) {
        const since = i - ep.index;
        const dist = (sign * (close - ep.level)) / ep.atr;
        if (dist < 0) {
          return [{ state: 'failed', level: ep.level, atr: ep.atr, triggerTime: ep.t, barsSince: since, dist }, null];
        }
        const state = dist > s.extendAtr ? 'extended' : since <= s.freshBars ? 'fresh' : 'holding';
        return [{ state, level: ep.level, atr: ep.atr, triggerTime: ep.t, barsSince: since, dist }, ep];
      }
      if (!(atr > 0)) return [{ ...UNKNOWN }, null];
      const dist = (sign * (close - edge)) / atr;
      if (dist > 0) {
        const next: Episode = { index: i, t: bars[i].t, level: edge, atr };
        const state = dist <= s.extendAtr ? 'fresh' : 'extended';
        return [{ state, level: edge, atr, triggerTime: bars[i].t, barsSince: 0, dist }, next];
      }
      const state = -dist <= s.nearAtr ? 'near' : 'none';
      return [{ state, level: edge, atr, triggerTime: null, barsSince: 0, dist }, null];
    };

    const [u, nextUp] = step('up', up);
    const [d, nextDown] = step('down', down);
    up = nextUp;
    down = nextDown;
    out.push({ up: u, down: d });
  }
  return out;
}

/**
 * What the live price says on top of the last closed bar's state: the
 * distance from the level now, and whether the price has crossed a level
 * that no closed bar has confirmed yet. Never changes the closed-bar state.
 */
export interface LiveBreakout {
  /** Distance of the live price from the level, in ATR, positive in the breakout's direction. */
  dist: number;
  level: number;
  /** No breakout is active, but the live price is already beyond the range of the last closed bars. */
  crossing: boolean;
  /** A breakout is active, but the live price is back inside its level. */
  slipping: boolean;
}

/**
 * Live view for one direction. `last` is the state at the last closed bar;
 * `bars` are the closed bars that state was computed from.
 */
export function liveBreakout(
  bars: Candle[],
  last: SideBreakout,
  dir: Direction,
  price: number,
  s: BreakoutSettings = DEFAULT_BREAKOUT,
): LiveBreakout {
  const sign = dir === 'up' ? 1 : -1;
  const active = last.state === 'fresh' || last.state === 'holding' || last.state === 'extended';
  if (active) {
    const dist = (sign * (price - last.level)) / last.atr;
    return { dist, level: last.level, crossing: false, slipping: dist < 0 };
  }
  // The range the next bar will be judged against: the last rangeBars closed bars.
  const n = bars.length;
  if (last.state === 'unknown' || n < s.rangeBars || !contiguous(bars, n - 1, s.rangeBars)) {
    return { dist: NaN, level: NaN, crossing: false, slipping: false };
  }
  let edge = dir === 'up' ? -Infinity : Infinity;
  for (let k = n - s.rangeBars; k < n; k++) edge = dir === 'up' ? Math.max(edge, bars[k].high) : Math.min(edge, bars[k].low);
  const dist = (sign * (price - edge)) / last.atr;
  return { dist, level: edge, crossing: dist > 0, slipping: false };
}

const NAMES: Record<Direction, Record<BreakoutState, string>> = {
  up: { unknown: '資料不足', none: '區間內', near: '接近突破', fresh: '剛突破', holding: '突破後整理', extended: '已延伸', failed: '跌回區間' },
  down: { unknown: '資料不足', none: '區間內', near: '接近跌破', fresh: '剛跌破', holding: '跌破後整理', extended: '已延伸', failed: '漲回區間' },
};

export function stateName(state: BreakoutState, dir: Direction): string {
  return NAMES[dir][state];
}
