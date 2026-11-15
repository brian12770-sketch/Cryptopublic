import { describe, expect, it } from 'vitest';
import {
  clusterBootstrap,
  computeFeatures,
  DAY_MS,
  FEE_PCT,
  findTrades,
  fires,
  HOLDS,
  REGISTERED,
  summarise,
  unconditional,
  type Features,
  type Row,
  type Trade,
} from '../backtest/engine';
import { BAR_MS, computeRvol } from '../src/lib/metrics';
import type { Bar } from '../src/types';

const T0 = 1794700800000; // a UTC midnight, on a 15-minute boundary

function row(i: number, over: Partial<Row> = {}): Row {
  return { t: T0 + i * BAR_MS, open: 100, close: 100, turnover: 1000, oi: 5000, takerBuy: 500, takerSell: 500, funding: NaN, ...over };
}

/** Deterministic pseudo-random turnovers, some of them zero. */
function noisy(n: number): Row[] {
  let s = 12345;
  const next = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: n }, (_, i) => row(i, { turnover: next() < 0.05 ? 0 : Math.round(next() * 1e6) }));
}

describe('computeFeatures', () => {
  it('gives the same RVOL as the function the website uses', () => {
    const rows = noisy(700);
    const bars: Bar[] = rows.map((r) => ({ t: r.t, open: r.open, close: r.close, turnover: r.turnover, takerBuy: null }));
    const features = computeFeatures(rows);
    for (const i of [10, 47, 48, 49, 200, 288, 289, 290, 500, 699]) {
      const site = computeRvol(bars, rows[i].t);
      if (site.kind === 'ok') expect(features[i].rvol).toBeCloseTo(site.value, 10);
      else expect(features[i].rvol).toBeNaN();
    }
  });

  it('computes the bar return, taker ratio and one-bar OI change', () => {
    const rows = [row(0, { oi: 1000 }), row(1, { open: 100, close: 101, oi: 1010, takerBuy: 600, takerSell: 400 })];
    const f = computeFeatures(rows)[1];
    expect(f.ret15).toBeCloseTo(1, 10);
    expect(f.taker).toBeCloseTo(1.5, 10);
    expect(f.oi15).toBeCloseTo(1, 10);
  });

  it('gives no OI change across a gap or a missing snapshot, and no ratio without taker data', () => {
    const gap = computeFeatures([row(0), row(2)])[1];
    expect(gap.oi15).toBeNaN();
    const missing = computeFeatures([row(0, { oi: NaN }), row(1, { takerBuy: NaN, takerSell: NaN })])[1];
    expect(missing.oi15).toBeNaN();
    expect(missing.taker).toBeNaN();
  });
});

describe('fires', () => {
  const f = (over: Partial<Features>): Features => ({ ret15: 0.6, rvol: 2.5, taker: 1.3, oi15: 0.4, ...over });

  it('applies the registered thresholds', () => {
    expect(fires(f({}), REGISTERED.base, 'long')).toBe(true);
    expect(fires(f({ ret15: 0.49 }), REGISTERED.base, 'long')).toBe(false);
    expect(fires(f({ rvol: 1.99 }), REGISTERED.base, 'long')).toBe(false);
    expect(fires(f({}), REGISTERED.full, 'long')).toBe(true);
    expect(fires(f({ taker: 1.24 }), REGISTERED.full, 'long')).toBe(false);
    expect(fires(f({ oi15: 0.29 }), REGISTERED.full, 'long')).toBe(false);
  });

  it('mirrors price and taker flow for shorts but still wants open interest to rise', () => {
    expect(fires(f({ ret15: -0.6, taker: 0.75 }), REGISTERED.full, 'short')).toBe(true);
    expect(fires(f({ ret15: -0.6, taker: 0.85 }), REGISTERED.full, 'short')).toBe(false);
    expect(fires(f({ ret15: -0.6, taker: 0.75, oi15: -0.4 }), REGISTERED.full, 'short')).toBe(false);
    expect(fires(f({ ret15: 0.6 }), REGISTERED.base, 'short')).toBe(false);
  });

  it('never fires on a missing feature', () => {
    expect(fires(f({ rvol: NaN }), REGISTERED.base, 'long')).toBe(false);
    expect(fires(f({ taker: NaN }), REGISTERED.full, 'long')).toBe(false);
    expect(fires(f({ oi15: NaN }), REGISTERED.full, 'long')).toBe(false);
    expect(fires(f({ taker: NaN }), REGISTERED.base, 'long')).toBe(true);
  });
});

describe('findTrades', () => {
  const quiet: Features = { ret15: 0, rvol: 1, taker: 1, oi15: 0 };
  const hot: Features = { ret15: 1, rvol: 3, taker: 1.5, oi15: 0.5 };
  const window = [T0, T0 + 100 * BAR_MS] as const;

  it('enters at the next open and exits at the open four bars later, net of fees', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    rows[11].open = 200; // entry bar
    rows[15].open = 202; // exit: four bars after entry
    const features = rows.map((_, i) => (i === 10 ? hot : quiet));
    const [trade, ...rest] = findTrades('X', rows, features, REGISTERED.base, 'long', ...window, HOLDS);
    expect(rest).toHaveLength(0);
    expect(trade.signalTime).toBe(rows[10].t);
    expect(trade.entryTime).toBe(rows[11].t);
    expect(trade.gross[4]).toBeCloseTo(1, 10);
    expect(trade.net[4]).toBeCloseTo(1 - FEE_PCT, 10);
  });

  it('flips the sign for shorts', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    rows[11].open = 200;
    rows[15].open = 202;
    const features = rows.map((_, i) => (i === 10 ? { ...hot, ret15: -1 } : quiet));
    const [trade] = findTrades('X', rows, features, REGISTERED.base, 'short', ...window, HOLDS);
    expect(trade.gross[4]).toBeCloseTo(-1, 10);
    expect(trade.net[4]).toBeCloseTo(-1 - FEE_PCT, 10);
  });

  it('charges a long, and credits a short, funding settled during the hold', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    rows[13].funding = 0.0002; // 0.02%, settled two bars after entry
    rows[11].funding = 0.0005; // settled at entry itself: not inside (entry, exit]
    const long = findTrades('X', rows, rows.map((_, i) => (i === 10 ? hot : quiet)), REGISTERED.base, 'long', ...window, HOLDS)[0];
    const short = findTrades('X', rows, rows.map((_, i) => (i === 10 ? { ...hot, ret15: -1 } : quiet)), REGISTERED.base, 'short', ...window, HOLDS)[0];
    expect(long.net[4]).toBeCloseTo(-FEE_PCT - 0.02, 10);
    expect(short.net[4]).toBeCloseTo(-FEE_PCT + 0.02, 10);
  });

  it('skips signals while a trade is open and takes the next one after it closes', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i));
    const features = rows.map((_, i) => ([10, 12, 14, 15].includes(i) ? hot : quiet));
    const trades = findTrades('X', rows, features, REGISTERED.base, 'long', ...window, HOLDS);
    // Signal 10 holds bars 11..14 and exits at the open of 15; signal 14 would enter at 15.
    expect(trades.map((t) => t.signalTime)).toEqual([rows[10].t, rows[14].t]);
  });

  it('drops a signal whose entry or exit bar is missing, and signals outside the window', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i)).filter((_, i) => i !== 13);
    const features = rows.map((r) => (r.t === T0 + 10 * BAR_MS ? hot : quiet));
    expect(findTrades('X', rows, features, REGISTERED.base, 'long', ...window, HOLDS)).toHaveLength(0);
    const full = Array.from({ length: 30 }, (_, i) => row(i));
    const f2 = full.map((_, i) => (i === 10 ? hot : quiet));
    expect(findTrades('X', full, f2, REGISTERED.base, 'long', T0 + 11 * BAR_MS, T0 + 100 * BAR_MS)).toHaveLength(0);
  });

  it('follows custom thresholds, holding period and fee', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    rows[11].open = 200;
    rows[13].open = 204; // two bars after entry
    const mild: Features = { ret15: 0.3, rvol: 1.6, taker: 1.1, oi15: 0 };
    const features = rows.map((_, i) => (i === 10 ? mild : quiet));
    expect(findTrades('X', rows, features, REGISTERED.base, 'long', ...window)).toHaveLength(0);
    const loose = { ...REGISTERED.base, retMin: 0.2, rvolMin: 1.5, hold: 2, feePct: 0.04 };
    const [trade] = findTrades('X', rows, features, loose, 'long', ...window);
    expect(trade.gross[2]).toBeCloseTo(2, 10);
    expect(trade.net[2]).toBeCloseTo(2 - 0.04, 10);
    // Turning on the taker filter with a bar that lacks the flow removes the trade.
    expect(findTrades('X', rows, features, { ...loose, useTaker: true, takerMin: 1.25 }, 'long', ...window)).toHaveLength(0);
  });
});

describe('statistics', () => {
  it('unconditional return averages every possible entry', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, { open: 100 + i }));
    const { mean, n } = unconditional([rows], 4, T0, T0 + 100 * BAR_MS);
    expect(n).toBe(5); // entries at bars 1..5 have an exit four bars later
    const expected = [1, 2, 3, 4, 5].map((i) => (4 / (100 + i)) * 100);
    expect(mean).toBeCloseTo(expected.reduce((a, b) => a + b) / 5, 10);
  });

  it('cluster bootstrap is deterministic and widens when clusters move together', () => {
    const values = [1, 1, 1, 1, -1, -1, -1, -1];
    const independent = clusterBootstrap(values, [0, 1, 2, 3, 4, 5, 6, 7]);
    const clustered = clusterBootstrap(values, [0, 0, 0, 0, 1, 1, 1, 1]);
    expect(clusterBootstrap(values, [0, 0, 0, 0, 1, 1, 1, 1])).toEqual(clustered);
    expect(clustered.clusters).toBe(2);
    expect(clustered.hi - clustered.lo).toBeGreaterThan(independent.hi - independent.lo);
  });

  const trade = (i: number, net: number): Trade => ({
    instId: i % 3 ? 'A' : 'B',
    side: 'long',
    signalTime: T0 + i * DAY_MS,
    entryTime: T0 + i * DAY_MS + BAR_MS,
    gross: { 1: net + FEE_PCT, 4: net + FEE_PCT, 16: net + FEE_PCT },
    net: { 1: net, 4: net, 16: net },
  });

  it('applies the registered verdict rules', () => {
    const span = [T0, T0 + 40 * DAY_MS] as const;
    const strong = Array.from({ length: 40 }, (_, i) => trade(i, 0.5 + (i % 5) * 0.1));
    expect(summarise(strong, 4, ...span).verdict).toBe('有效');
    expect(summarise(strong.slice(0, 29), 4, ...span).verdict).toBe('無統計意義');
    const noise = Array.from({ length: 40 }, (_, i) => trade(i, i % 2 ? 1 : -1));
    expect(summarise(noise, 4, ...span).verdict).toBe('無效');
    // Positive overall, but the second half loses: not robust, so not valid.
    const fading = Array.from({ length: 40 }, (_, i) => trade(i, i < 20 ? 2 : -0.1));
    const s = summarise(fading, 4, ...span);
    expect(s.netMean).toBeGreaterThan(0);
    expect(s.verdict).toBe('無效');
  });
});

describe('browser data loader parsing', () => {
  it('reads Binance klines into rows with the taker split', async () => {
    const { parseBinanceRows } = await import('../src/lib/backtestData');
    const klines = (await import('./fixtures/binance-klines.json')).default;
    const rows = parseBinanceRows(klines);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ t: 1794722400000, open: 64478.7, close: 64425.3, turnover: 987200455.9, takerBuy: 476100000.3 });
    expect(rows[1].takerSell).toBeCloseTo(987200455.9 - 476100000.3, 4);
    expect(rows[1].oi).toBeNaN();
    expect(rows[1].funding).toBeNaN();
  });

  it('snaps Binance funding times, which run a few ms late, onto the bar they settle at', async () => {
    const { parseBinanceFunding } = await import('../src/lib/backtestData');
    const funding = parseBinanceFunding([
      { symbol: 'BTCUSDT', fundingTime: 1794729600003, fundingRate: '0.00010000', markPrice: '64000.0' },
      { symbol: 'BTCUSDT', fundingTime: 1794758400000, fundingRate: '-0.00002500', markPrice: '64100.0' },
    ]);
    expect([...funding]).toEqual([
      [1794729600000, 0.0001],
      [1794758400000, -0.000025],
    ]);
  });

  it('reads Binance open-interest history as snapshots in coins', async () => {
    const { parseBinanceOiHistory } = await import('../src/lib/backtestData');
    const oi = (await import('./fixtures/binance-oi.json')).default;
    expect(parseBinanceOiHistory(oi).get(1794741300000)).toBe(82224.201);
  });

  it('keeps only closed OKX candles', async () => {
    const { parseOkxRows } = await import('../src/lib/backtestData');
    const candles = (await import('./fixtures/okx-candles.json')).default;
    const rows = parseOkxRows(candles);
    // The fixture's newest candle was still forming when it was captured.
    expect(rows.map((r) => r.t)).not.toContain(1794742200000);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.t === 1794741300000)).toMatchObject({ open: 65285, close: 65419.3, turnover: 34780781.88219 });
  });

  it('ends the test window on a completed UTC day', async () => {
    const { testWindow, DAY_MS: day } = await import('../src/lib/backtestData');
    const now = Date.UTC(2026, 10, 15, 13, 30);
    expect(testWindow(30, now)).toEqual({ from: Date.UTC(2026, 9, 16), to: Date.UTC(2026, 10, 15) });
    expect(testWindow(30, now).to - testWindow(30, now).from).toBe(30 * day);
  });
});
