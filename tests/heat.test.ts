import { describe, expect, it } from 'vitest';
import { computeHeat, HOUR_MS, median, topByTurnover } from '../src/lib/heat';
import { changeClass, heatClass } from '../src/lib/scale';
import { fmtPct, fmtPrice, fmtRatio, fmtTurnover } from '../src/lib/format';
import type { HourBar, Ticker } from '../src/types';

const T0 = 1794700800000; // on an hour boundary

/** `n` closed bars ending just before `now`, oldest first. */
function bars(turnovers: number[], now: number): HourBar[] {
  const lastOpen = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  return turnovers.map((turnover, i) => ({ t: lastOpen - (turnovers.length - 1 - i) * HOUR_MS, turnover }));
}

describe('computeHeat', () => {
  const now = T0 + 5 * 60 * 1000;

  it('divides the last closed hour by the median of the hours before it', () => {
    const series = [...Array(48).fill(100), 300];
    const heat = computeHeat(bars(series, now), now);
    expect(heat).toEqual({ ratio: 3, barTime: T0 - HOUR_MS, baselineN: 48 });
  });

  it('ignores the bar still in progress', () => {
    const closed = bars([...Array(48).fill(100), 300], now);
    const inProgress: HourBar = { t: T0, turnover: 5 };
    expect(computeHeat([...closed, inProgress], now)?.ratio).toBe(3);
  });

  it('accepts bars in either order', () => {
    const closed = bars([...Array(48).fill(100), 250], now);
    expect(computeHeat([...closed].reverse(), now)?.ratio).toBe(2.5);
  });

  it('uses the median, so one earlier spike does not move the baseline', () => {
    const series = [...Array(47).fill(100), 100000, 200];
    expect(computeHeat(bars(series, now), now)?.ratio).toBe(2);
  });

  it('drops zero-volume bars from the baseline', () => {
    const series = [...Array(30).fill(0), ...Array(30).fill(100), 150];
    const heat = computeHeat(bars(series, now), now);
    expect(heat?.ratio).toBe(1.5);
    expect(heat?.baselineN).toBe(30);
  });

  it('uses at most 7 days of baseline', () => {
    const series = [...Array(200).fill(1), ...Array(168).fill(100), 100];
    const heat = computeHeat(bars(series, now), now);
    expect(heat?.baselineN).toBe(168);
    expect(heat?.ratio).toBe(1);
  });

  it('returns null when the baseline is under a day', () => {
    expect(computeHeat(bars([...Array(23).fill(100), 300], now), now)).toBeNull();
    expect(computeHeat([], now)).toBeNull();
  });

  it('returns null when the newest closed bar is hours old', () => {
    const old = bars([...Array(48).fill(100), 300], now);
    expect(computeHeat(old, now + 3 * HOUR_MS)).toBeNull();
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
    expect(changeClass(-0.99)).toBe('flat');
    expect(changeClass(0.99)).toBe('flat');
    expect(changeClass(1)).toBe('gain1');
    expect(changeClass(6)).toBe('gain3');
    expect(heatClass(0.99)).toBe('heat0');
    expect(heatClass(1)).toBe('heat1');
    expect(heatClass(2.99)).toBe('heat3');
    expect(heatClass(5)).toBe('heat5');
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

  it('signs percentages and ratios', () => {
    expect(fmtPct(2.514)).toBe('+2.51%');
    expect(fmtPct(-45.92)).toBe('-45.9%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtRatio(3.24)).toBe('3.2×');
    expect(fmtRatio(12.6)).toBe('13×');
  });
});
