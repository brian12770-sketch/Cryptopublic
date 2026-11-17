// Market breadth: how much of the top 50 moved together in the last closed
// 15-minute bar. Pure, so it can move to a backend unchanged.

import type { Metrics, Ticker } from '../types';

/** A bar counts as "with volume" from this RVOL on, the same threshold the board calls hot. */
export const BREADTH_RVOL = 2;

export interface Breadth {
  /** Contracts with both a 15-minute move and an RVOL for the bar. */
  judged: number;
  up: number;
  down: number;
  upWithVolume: number;
  downWithVolume: number;
  /** Open time of the bar most contracts were judged on; null before any. */
  barTime: number | null;
}

export function breadthOf(top: Ticker[], metrics: Record<string, Metrics>): Breadth {
  const out: Breadth = { judged: 0, up: 0, down: 0, upWithVolume: 0, downWithVolume: 0, barTime: null };
  const times = new Map<number, number>();
  for (const { symbol } of top) {
    const m = metrics[symbol];
    if (m?.ret15.kind !== 'ok' || m.rvol.kind !== 'ok') continue;
    out.judged++;
    times.set(m.barTime, (times.get(m.barTime) ?? 0) + 1);
    const ret = m.ret15.value;
    const hot = m.rvol.value >= BREADTH_RVOL;
    if (ret > 0) {
      out.up++;
      if (hot) out.upWithVolume++;
    } else if (ret < 0) {
      out.down++;
      if (hot) out.downWithVolume++;
    }
  }
  // Right after a bar closes some contracts still show the previous bar; report the majority.
  let best = 0;
  for (const [t, n] of times) {
    if (n > best) {
      best = n;
      out.barTime = t;
    }
  }
  return out;
}
