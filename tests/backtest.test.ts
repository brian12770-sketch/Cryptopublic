import { describe, expect, it } from 'vitest';
import {
  attachExcess,
  judgeable,
  universeByTime,
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

const nan3 = () => ({ '1h': NaN, '4h': NaN, '24h': NaN });
/** A feature record with only the per-bar fields set. */
function feat(over: Partial<Features>): Features {
  return { ret15: NaN, rvol: NaN, taker: NaN, oi15: NaN, lookback: nan3(), excess: nan3(), turnover24: NaN, breakout: null, ...over };
}

function row(i: number, over: Partial<Row> = {}): Row {
  return { t: T0 + i * BAR_MS, open: 100, high: 100, low: 100, close: 100, turnover: 1000, oi: 5000, takerBuy: 500, takerSell: 500, funding: NaN, ...over };
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
    const bars: Bar[] = rows.map((r) => ({ t: r.t, open: r.open, high: r.high, low: r.low, close: r.close, turnover: r.turnover, takerBuy: null }));
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
  const f = (over: Partial<Features>): Features => feat({ ret15: 0.6, rvol: 2.5, taker: 1.3, oi15: 0.4, ...over });

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
  const quiet: Features = feat({ ret15: 0, rvol: 1, taker: 1, oi15: 0 });
  const hot: Features = feat({ ret15: 1, rvol: 3, taker: 1.5, oi15: 0.5 });
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
    const mild: Features = feat({ ret15: 0.3, rvol: 1.6, taker: 1.1, oi15: 0 });
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

describe('conditions that can be switched off, and strength against BTC', () => {
  const base = { ...REGISTERED.base };

  it('never fires with every condition off', () => {
    const none = { ...base, useRet: false, useRvol: false };
    expect(fires(feat({ ret15: 5, rvol: 9 }), none, 'long')).toBe(false);
  });

  it('applies only the conditions that are on', () => {
    const rvolOnly = { ...base, useRet: false };
    expect(fires(feat({ ret15: NaN, rvol: 2.5 }), rvolOnly, 'long')).toBe(true);
    expect(fires(feat({ ret15: NaN, rvol: 2.5 }), rvolOnly, 'short')).toBe(true);
  });

  it('requires beating BTC for longs and trailing it for shorts', () => {
    const rs = { ...base, useRet: false, useRvol: false, useRs: true, rsHorizon: '4h' as const, rsMin: 2 };
    const ahead = feat({ excess: { '1h': 0, '4h': 2.5, '24h': 0 } });
    const behind = feat({ excess: { '1h': 0, '4h': -2.5, '24h': 0 } });
    expect(fires(ahead, rs, 'long')).toBe(true);
    expect(fires(ahead, rs, 'short')).toBe(false);
    expect(fires(behind, rs, 'short')).toBe(true);
    expect(fires(feat({}), rs, 'long')).toBe(false);
  });

  it('tells an unjudgeable bar apart from one with no signal', () => {
    const p = { ...base, useOi: true };
    expect(judgeable(feat({ ret15: 0, rvol: 1, oi15: 0 }), p)).toBe(true);
    expect(judgeable(feat({ ret15: 0, rvol: 1 }), p)).toBe(false);
  });

  it('computes look-backs, the trailing day and the excess over BTC', () => {
    const coin = Array.from({ length: 120 }, (_, i) => row(i, { close: 100 + i, turnover: 10 }));
    const btc = Array.from({ length: 120 }, (_, i) => row(i, { close: 1000 + i, turnover: 50 }));
    const rows = new Map([
      ['COIN', coin],
      ['BTC', btc],
    ]);
    const features = new Map([...rows].map(([id, r]) => [id, computeFeatures(r)]));
    expect(attachExcess(features, rows, 'BTC')).toBe(true);
    const f = features.get('COIN')![110];
    expect(f.lookback['1h']).toBeCloseTo((210 / 206 - 1) * 100, 10);
    expect(f.lookback['24h']).toBeCloseTo((210 / 114 - 1) * 100, 10);
    const btc1h = (1110 / 1106 - 1) * 100;
    expect(f.excess['1h']).toBeCloseTo((210 / 206 - 1) * 100 - btc1h, 10);
    expect(features.get('BTC')![110].excess['4h']).toBeCloseTo(0, 10);
    // A full day of bars is needed for the trailing turnover and the 24h look-back.
    expect(f.turnover24).toBe(960);
    expect(features.get('COIN')![94].turnover24).toBeNaN();
    expect(features.get('COIN')![95].lookback['24h']).toBeNaN();
  });

  it('ranks the point-in-time top N by trailing 24h turnover', () => {
    const mk = (turnover: number) => Array.from({ length: 100 }, (_, i) => row(i, { turnover }));
    const rows = new Map([
      ['A', mk(5)],
      ['B', mk(50)],
      ['C', mk(20)],
    ]);
    const features = new Map([...rows].map(([id, r]) => [id, computeFeatures(r)]));
    const top = universeByTime(features, rows, 2);
    expect([...top.get(T0 + 99 * BAR_MS)!].sort()).toEqual(['B', 'C']);
    // Before a full day exists nobody is ranked.
    expect(top.has(T0 + 50 * BAR_MS)).toBe(false);
  });

  it('only trades bars the allow filter lets through', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    const hot = feat({ ret15: 1, rvol: 3 });
    const quiet = feat({ ret15: 0, rvol: 1 });
    const features = rows.map((_, i) => (i === 10 || i === 20 ? hot : quiet));
    const allowed = findTrades('X', rows, features, base, 'long', T0, T0 + 100 * BAR_MS, [4], (t) => t !== rows[10].t);
    expect(allowed.map((t) => t.signalTime)).toEqual([rows[20].t]);
  });
});

describe('screener and tracker definitions', () => {
  it('judges live metrics with the engine rules and explains what it could not judge', async () => {
    const { runScreen, DEFAULT_SCREEN } = await import('../src/lib/screen');
    const ok = (value: number) => ({ kind: 'ok' as const, value });
    const lb = (h4: number) => ({ '1h': ok(0), '4h': ok(h4), '24h': ok(0) });
    const metrics = (over: object) => ({
      barTime: 0,
      rvol: ok(2.5),
      ret15: ok(0.8),
      taker: ok(1.3),
      oi15: ok(0.4),
      oi1h: ok(0),
      oiTime: null,
      lookback: lb(3),
      ...over,
    });
    const tick = (base: string) => ({ symbol: `${base}USDT`, base, price: 1, changePct: 0, turnover24h: 1, turnoverApprox: false });
    const top = [tick('BTC'), tick('AAA'), tick('BBB'), tick('CCC'), tick('DDD')];
    // The momentum conditions without the breakout one, so no candles are needed.
    const screen = { side: 'both' as const, conditions: { ...DEFAULT_SCREEN.conditions, useRet: true, useBreakout: false } };
    const result = runScreen(screen, top, {
      BTCUSDT: metrics({ lookback: lb(1) }), // excess 0 against itself: no match
      AAAUSDT: metrics({}), // +0.8%, RVOL 2.5, 4h +3 vs BTC +1: long
      BBBUSDT: metrics({ ret15: ok(-0.9), lookback: lb(-2) }), // short
      CCCUSDT: metrics({ rvol: { kind: 'pending' } }),
      DDDUSDT: metrics({ lookback: { '1h': ok(0), '4h': { kind: 'insufficient' }, '24h': ok(0) } }),
    } as never, {});
    expect(result.matches.map((m) => `${m.ticker.base} ${m.side}`)).toEqual(['AAA long', 'BBB short']);
    expect(result.judged).toBe(3);
    expect(result.pending).toBe(1);
    expect(result.missing).toBe(1);
  });

  it('accepts a well-formed tracker and explains what is wrong with a bad one', async () => {
    const { parseTrackerDef } = await import('../src/lib/tracker');
    const { DEFAULT_SCREEN } = await import('../src/lib/screen');
    const good = { name: ' 強勢 ', side: 'long', holdBars: 4, feePct: 0.1, conditions: DEFAULT_SCREEN.conditions };
    const parsed = parseTrackerDef(good);
    expect(typeof parsed).toBe('object');
    expect(parsed).toMatchObject({ name: '強勢', side: 'long', holdBars: 4 });
    expect(parseTrackerDef({ ...good, holdBars: 3 })).toMatch(/holdBars/);
    expect(parseTrackerDef({ ...good, side: 'up' })).toMatch(/side/);
    expect(parseTrackerDef({ ...good, conditions: { ...good.conditions, takerMin: 0.8 } })).toMatch(/conditions/);
    const off = Object.fromEntries(Object.entries(good.conditions).map(([k, v]) => [k, k.startsWith('use') ? false : v]));
    expect(parseTrackerDef({ ...good, conditions: off })).toMatch(/至少/);
  });

  it('builds a GitHub new-file link that carries the file name and content', async () => {
    const { githubNewFileUrl, trackerFileName, trackerJson } = await import('../src/lib/tracker');
    const { DEFAULT_SCREEN } = await import('../src/lib/screen');
    const def = { name: '測試', side: 'both' as const, holdBars: 4, feePct: 0.1, conditions: DEFAULT_SCREEN.conditions };
    const name = trackerFileName(new Date(Date.UTC(2026, 10, 16, 9, 5)));
    expect(name).toBe('20261116-0905.json');
    const url = new URL(githubNewFileUrl(def, name));
    expect(url.pathname).toBe('/brian12770-sketch/Cryptopublic/new/claude/sleepy-mendel-cga24x');
    expect(url.searchParams.get('filename')).toBe('trackers/20261116-0905.json');
    expect(JSON.parse(url.searchParams.get('value')!)).toEqual(def);
    expect(trackerJson(def).endsWith('\n')).toBe(true);
  });

  it('finds a fresh breakout from closed candles and reads the live price against the frozen level', async () => {
    const { runScreen, breakoutAtBar } = await import('../src/lib/screen');
    const ok = (value: number) => ({ kind: 'ok' as const, value });
    // 30 flat bars (99–101), then a breakout bar closing at 102, then the bar still forming.
    const bars = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * BAR_MS, open: 100, high: 101, low: 99, close: 100, turnover: 1, takerBuy: null }));
    bars.push({ t: T0 + 30 * BAR_MS, open: 100, high: 102.5, low: 100, close: 102, turnover: 1, takerBuy: null });
    bars.push({ t: T0 + 31 * BAR_MS, open: 102, high: 102.2, low: 101.9, close: 102.1, turnover: 1, takerBuy: null });
    const at = T0 + 30 * BAR_MS;
    const m = { barTime: at, rvol: ok(3), ret15: ok(2), taker: ok(1), oi15: ok(0), oi1h: ok(0), oiTime: null, lookback: { '1h': ok(0), '4h': ok(0), '24h': ok(0) } };
    const top = [{ symbol: 'AAAUSDT', base: 'AAA', price: 102.4, changePct: 0, turnover24h: 1, turnoverApprox: false }];
    const conditions = { ...REGISTERED.base, useRet: false, useRvol: false, useBreakout: true, breakoutState: 'fresh' as const };
    const breakouts = breakoutAtBar(top, { AAAUSDT: m } as never, { AAAUSDT: bars }, conditions);
    // The forming bar is left out: the state is that of the bar the metrics describe.
    expect(breakouts.AAAUSDT?.closed).toHaveLength(31);
    const result = runScreen({ side: 'both', conditions }, top, { AAAUSDT: m } as never, breakouts);
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match.side).toBe('long');
    expect(match.breakout).toMatchObject({ state: 'fresh', level: 101, triggerTime: at });
    // ATR over the last 14 bars: 13 flat bars of 2 and the breakout bar's 2.5.
    const atr = (13 * 2 + 2.5) / 14;
    expect(match.live?.dist).toBeCloseTo((102.4 - 101) / atr, 10);
    expect(match.live?.slipping).toBe(false);
  });
});
