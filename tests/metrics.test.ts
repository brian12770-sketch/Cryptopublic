import { describe, expect, it } from 'vitest';
import {
  BAR_MS,
  computeOiChange,
  computeReturn,
  computeRvol,
  lastClosedBarTime,
  median,
  oiAnchor,
  takerFromBars,
  takerFromPoints,
  topByTurnover,
} from '../src/lib/metrics';
import { changeClass, oiClass, rvolClass, takerClass } from '../src/lib/scale';
import { fmtPct, fmtPrice, fmtRatio, fmtTaker, fmtTurnover } from '../src/lib/format';
import type { Bar, OiPoint, Ticker } from '../src/types';

const T = 1794700800000; // on a 15-minute boundary
const ok = (value: number) => ({ kind: 'ok', value });
const INSUFFICIENT = { kind: 'insufficient' };

/** Bars ending with the one that opens at `last`, oldest first, one per turnover. */
function bars(turnovers: number[], last: number): Bar[] {
  return turnovers.map((turnover, i) => ({
    t: last - (turnovers.length - 1 - i) * BAR_MS,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    turnover,
    takerBuy: turnover / 2,
  }));
}

describe('lastClosedBarTime', () => {
  it('is the bar before the one in progress', () => {
    expect(lastClosedBarTime(T + 60_000)).toBe(T - BAR_MS);
    expect(lastClosedBarTime(T)).toBe(T - BAR_MS);
    expect(lastClosedBarTime(T - 1)).toBe(T - 2 * BAR_MS);
  });
});

describe('computeRvol', () => {
  it('divides the bar by the median of the bars before it', () => {
    expect(computeRvol(bars([...Array(96).fill(100), 300], T), T)).toEqual(ok(3));
  });

  it('ignores bars after the target, such as the one in progress', () => {
    const series = bars([...Array(96).fill(100), 300], T);
    series.push({ t: T + BAR_MS, open: 100, high: NaN, low: NaN, close: 100, turnover: 5, takerBuy: 2 });
    expect(computeRvol(series, T)).toEqual(ok(3));
  });

  it('accepts bars in either order', () => {
    expect(computeRvol(bars([...Array(96).fill(100), 250], T).reverse(), T)).toEqual(ok(2.5));
  });

  it('uses the median, so one earlier spike does not move the baseline', () => {
    expect(computeRvol(bars([...Array(95).fill(100), 100000, 200], T), T)).toEqual(ok(2));
  });

  it('drops zero-volume bars from the baseline', () => {
    expect(computeRvol(bars([...Array(60).fill(0), ...Array(60).fill(100), 150], T), T)).toEqual(ok(1.5));
  });

  it('uses at most 3 days of baseline', () => {
    expect(computeRvol(bars([...Array(300).fill(1), ...Array(288).fill(100), 100], T), T)).toEqual(ok(1));
  });

  it('is insufficient under 12 hours of baseline or when the bar is missing', () => {
    expect(computeRvol(bars([...Array(47).fill(100), 300], T), T)).toEqual(INSUFFICIENT);
    expect(computeRvol(bars([...Array(96).fill(100), 300], T - BAR_MS), T)).toEqual(INSUFFICIENT);
    expect(computeRvol([], T)).toEqual(INSUFFICIENT);
  });
});

describe('computeReturn', () => {
  it('is the bar open-to-close change in percent', () => {
    const cell = computeReturn([{ t: T, open: 65285, high: NaN, low: NaN, close: 65419.3, turnover: 1, takerBuy: null }], T);
    expect(cell.kind === 'ok' && cell.value).toBeCloseTo(0.2057, 4);
    expect(computeReturn([], T)).toEqual(INSUFFICIENT);
  });
});

describe('taker ratio', () => {
  it('splits a candle into taker buys and the remainder', () => {
    const bar: Bar = { t: T, open: 1, high: NaN, low: NaN, close: 1, turnover: 1000, takerBuy: 600 };
    expect(takerFromBars([bar], T)).toEqual(ok(1.5));
  });

  it('reads a separate taker series for the same bar only', () => {
    const points = [
      { t: T - BAR_MS, buy: 10, sell: 40 },
      { t: T, buy: 16269809.18, sell: 18510972.7 },
    ];
    const cell = takerFromPoints(points, T);
    expect(cell.kind === 'ok' && cell.value).toBeCloseTo(0.8789, 4);
    expect(takerFromPoints(points, T + BAR_MS)).toEqual(INSUFFICIENT);
  });

  it('is insufficient without a split or without any taker selling', () => {
    expect(takerFromBars([{ t: T, open: 1, high: NaN, low: NaN, close: 1, turnover: 1000, takerBuy: null }], T)).toEqual(INSUFFICIENT);
    expect(takerFromBars([{ t: T, open: 1, high: NaN, low: NaN, close: 1, turnover: 1000, takerBuy: 1000 }], T)).toEqual(INSUFFICIENT);
    expect(takerFromBars([{ t: T, open: 1, high: NaN, low: NaN, close: 1, turnover: 0, takerBuy: 0 }], T)).toEqual(INSUFFICIENT);
  });
});

describe('open interest change', () => {
  const close = T + BAR_MS;
  const series = (latest: number): OiPoint[] =>
    [0, 1, 2, 3, 4, 5].map((i) => ({ t: latest - i * BAR_MS, oi: 1000 - i * 10 }));

  it('measures across the bar and across the hour ending at its close', () => {
    const points = series(close); // 1000 at close, 990 a bar earlier, 960 an hour earlier
    const oi15 = computeOiChange(points, close, BAR_MS);
    const oi1h = computeOiChange(points, close, 4 * BAR_MS);
    expect(oi15.kind === 'ok' && oi15.value).toBeCloseTo((1000 / 990 - 1) * 100, 8);
    expect(oi1h.kind === 'ok' && oi1h.value).toBeCloseTo((1000 / 960 - 1) * 100, 8);
    expect(oiAnchor(points, close)?.t).toBe(close);
  });

  it('falls back one bar when the exchange has not published the close yet', () => {
    const points = series(close - BAR_MS);
    const oi15 = computeOiChange(points, close, BAR_MS);
    expect(oi15.kind === 'ok' && oi15.value).toBeCloseTo((1000 / 990 - 1) * 100, 8);
    expect(oiAnchor(points, close)?.t).toBe(close - BAR_MS);
  });

  it('is insufficient when the newest snapshot is two bars old, or an end is missing', () => {
    expect(computeOiChange(series(close - 2 * BAR_MS), close, BAR_MS)).toEqual(INSUFFICIENT);
    expect(computeOiChange([{ t: close, oi: 1000 }], close, BAR_MS)).toEqual(INSUFFICIENT);
    expect(computeOiChange(series(close).slice(0, 3), close, 4 * BAR_MS)).toEqual(INSUFFICIENT);
  });
});

describe('ranking and scales', () => {
  it('median handles even and odd counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ranks by turnover and truncates', () => {
    const mk = (symbol: string, turnover24h: number): Ticker => ({
      symbol,
      base: symbol,
      price: 1,
      changePct: 0,
      turnover24h,
      turnoverApprox: false,
    });
    const top = topByTurnover([mk('A', 5), mk('B', 50), mk('C', 20)], 2);
    expect(top.map((t) => t.symbol)).toEqual(['B', 'C']);
  });

  it('puts boundary values in the higher class', () => {
    expect(changeClass(-6.01)).toBe('loss3');
    expect(changeClass(-6)).toBe('loss2');
    expect(changeClass(0.99)).toBe('flat');
    expect(changeClass(6)).toBe('gain3');
    expect(rvolClass(0.99)).toBe('heat0');
    expect(rvolClass(1)).toBe('heat1');
    expect(rvolClass(5)).toBe('heat5');
    expect(oiClass(-2.5)).toBe('oiDn3');
    expect(oiClass(-0.1)).toBe('flat');
    expect(oiClass(0.3)).toBe('oiUp1');
    expect(oiClass(2)).toBe('oiUp3');
  });

  it('treats the taker ratio symmetrically around 1', () => {
    expect(takerClass(1)).toBe('flat');
    expect(takerClass(1.3)).toBe('gain2');
    expect(takerClass(1 / 1.3)).toBe('loss2');
    expect(takerClass(2)).toBe('gain3');
    expect(takerClass(0.5)).toBe('loss3');
  });
});

describe('formatting', () => {
  it('compacts turnover', () => {
    expect(fmtTurnover(8292974238.9)).toBe('8.29B');
    expect(fmtTurnover(568208000)).toBe('568M');
    expect(fmtTurnover(13698911.8)).toBe('13.7M');
    expect(fmtTurnover(920400)).toBe('920K');
  });

  it('keeps useful digits at every price scale', () => {
    expect(fmtPrice(64355.6)).toBe('64,355.6');
    expect(fmtPrice(105.21)).toBe('105.21');
    expect(fmtPrice(0.0114303)).toBe('0.01143');
  });

  it('signs percentages and formats ratios', () => {
    expect(fmtPct(2.514)).toBe('+2.51%');
    expect(fmtPct(-45.92)).toBe('-45.9%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtRatio(3.24)).toBe('3.2×');
    expect(fmtRatio(12.6)).toBe('13×');
    expect(fmtTaker(0.8789)).toBe('0.88');
    expect(fmtTaker(1.5)).toBe('1.50');
  });
});

describe('relative strength', () => {
  it('measures close to close across the look-back, ending at the target bar', async () => {
    const { computeLookback, HORIZON_BARS } = await import('../src/lib/metrics');
    // Closes rise by 1 each bar: 100 at bar 0, 196 at bar 96.
    const series: Bar[] = Array.from({ length: 98 }, (_, i) => ({ t: T + i * BAR_MS, open: 99 + i, high: NaN, low: NaN, close: 100 + i, turnover: 1, takerBuy: null }));
    const at = T + 96 * BAR_MS;
    const value = (span: number) => {
      const cell = computeLookback(series, at, span);
      return cell.kind === 'ok' ? cell.value : NaN;
    };
    expect(value(HORIZON_BARS['1h'])).toBeCloseTo((196 / 192 - 1) * 100, 10);
    expect(value(HORIZON_BARS['4h'])).toBeCloseTo((196 / 180 - 1) * 100, 10);
    expect(value(HORIZON_BARS['24h'])).toBeCloseTo((196 / 100 - 1) * 100, 10);
    // The bar after the target (still forming) must not change the answer.
    expect(value(4)).toBeCloseTo((196 / 192 - 1) * 100, 10);
  });

  it('is insufficient when either end of the window is missing', async () => {
    const { computeLookback } = await import('../src/lib/metrics');
    const young: Bar[] = Array.from({ length: 10 }, (_, i) => ({ t: T + i * BAR_MS, open: 1, high: NaN, low: NaN, close: 1, turnover: 1, takerBuy: null }));
    expect(computeLookback(young, T + 9 * BAR_MS, 4)).toEqual({ kind: 'ok', value: 0 });
    expect(computeLookback(young, T + 9 * BAR_MS, 96)).toEqual(INSUFFICIENT);
    expect(computeLookback(young, T + 20 * BAR_MS, 4)).toEqual(INSUFFICIENT);
  });

  it('gives excess over the benchmark only when both are known', async () => {
    const { excessOver } = await import('../src/lib/metrics');
    expect(excessOver(ok(3) as never, ok(-1) as never)).toBe(4);
    expect(excessOver(ok(-2) as never, ok(1.5) as never)).toBe(-3.5);
    expect(excessOver(ok(3) as never, undefined)).toBeUndefined();
    expect(excessOver({ kind: 'pending' }, ok(1) as never)).toBeUndefined();
    expect(excessOver(ok(3) as never, { kind: 'insufficient' })).toBeUndefined();
  });

  it('uses wider colour classes for longer windows', async () => {
    const { rsClass, legendFor } = await import('../src/lib/scale');
    expect(rsClass(2, '1h')).toBe('gain2');
    expect(rsClass(2, '4h')).toBe('gain1');
    expect(rsClass(2, '24h')).toBe('gain1');
    expect(rsClass(1.9, '24h')).toBe('flat');
    expect(rsClass(-7, '4h')).toBe('loss3');
    expect(rsClass(-7, '24h')).toBe('loss2');
    expect(legendFor('rs', '4h').stops.map((s) => s.label)).toEqual(['≤ −6%', '−3%', '−1%', '相近', '+1%', '+3%', '≥ +6%']);
  });
});

describe('breadth', () => {
  it('counts rising and falling bars, and those with volume, among contracts it can judge', async () => {
    const { breadthOf } = await import('../src/lib/breadth');
    const ok = (value: number) => ({ kind: 'ok' as const, value });
    const m = (ret: number, rvol: number, barTime = 100) => ({ barTime, ret15: ok(ret), rvol: ok(rvol) });
    const top = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => ({ symbol: s, base: s, price: 1, changePct: 0, turnover24h: 1, turnoverApprox: false }));
    const b = breadthOf(top, {
      A: m(0.5, 3),
      B: m(0.2, 1),
      C: m(-0.4, 2),
      D: m(0, 5),
      E: { barTime: 100, ret15: { kind: 'pending' }, rvol: ok(4) },
      F: m(-1, 0.5, 85),
    } as never);
    expect(b).toEqual({ judged: 5, up: 2, down: 2, upWithVolume: 1, downWithVolume: 1, barTime: 100 });
  });
});
