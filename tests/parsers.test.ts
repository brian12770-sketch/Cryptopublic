import { describe, expect, it } from 'vitest';
import { parseBinanceKlines, parseBinanceOi, parseBinanceTickers } from '../src/exchanges/binance';
import { parseOkxCandles, parseOkxOi, parseOkxTaker, parseOkxTickers } from '../src/exchanges/okx';
import { parsePionexKlines, parsePionexTickers } from '../src/exchanges/pionex';
import { parseTrending } from '../src/lib/trending';
import { FetchError } from '../src/lib/http';

// OKX, Pionex and CoinGecko fixtures are real responses captured 2026-11-15.
// Binance fixtures follow its published schema: the API refused this build
// machine's region, so they were written by hand, not captured.
import okxTickers from './fixtures/okx-tickers.json';
import okxCandles from './fixtures/okx-candles.json';
import okxOi from './fixtures/okx-oi.json';
import okxTaker from './fixtures/okx-taker.json';
import pionexTickers from './fixtures/pionex-tickers.json';
import pionexKlines from './fixtures/pionex-klines.json';
import binanceTickers from './fixtures/binance-tickers.json';
import binanceKlines from './fixtures/binance-klines.json';
import binanceOi from './fixtures/binance-oi.json';
import trending from './fixtures/coingecko-trending.json';

const bySymbol = <T extends { symbol: string }>(rows: T[], symbol: string) => {
  const row = rows.find((r) => r.symbol === symbol);
  if (!row) throw new Error(`${symbol} missing`);
  return row;
};

describe('OKX', () => {
  const tickers = parseOkxTickers(okxTickers);

  it('keeps USDT-margined swaps only', () => {
    expect(tickers.map((t) => t.symbol).sort()).toEqual([
      'BTC-USDT-SWAP',
      'DOGE-USDT-SWAP',
      'ETH-USDT-SWAP',
      'PI-USDT-SWAP',
    ]);
  });

  it('derives 24h change from open24h', () => {
    const btc = bySymbol(tickers, 'BTC-USDT-SWAP');
    expect(btc.base).toBe('BTC');
    expect(btc.price).toBe(64349.9);
    expect(btc.changePct).toBeCloseTo(((64349.9 - 67340.2) / 67340.2) * 100, 6);
  });

  it('turns base-coin volume into USDT turnover of the right magnitude', () => {
    const btc = bySymbol(tickers, 'BTC-USDT-SWAP');
    // 188,223.66 BTC at roughly 62k–67k is about 12 billion USDT.
    expect(btc.turnoverApprox).toBe(true);
    expect(btc.turnover24h).toBeGreaterThan(188223.6623 * 61931.1);
    expect(btc.turnover24h).toBeLessThan(188223.6623 * 67487.4);
    // DOGE reports billions of coins; turnover must still land in the hundreds of millions.
    const doge = bySymbol(tickers, 'DOGE-USDT-SWAP');
    expect(doge.turnover24h).toBeGreaterThan(3e8);
    expect(doge.turnover24h).toBeLessThan(5e8);
  });

  it('reads open, close and USDT turnover from 15-minute candles', () => {
    const bars = parseOkxCandles(okxCandles);
    expect(bars).toHaveLength(4);
    expect(bars[1]).toEqual({ t: 1794741300000, open: 65285, close: 65419.3, turnover: 34780781.88219, takerBuy: null });
  });

  it('stamps open interest with the period close and drops the period in progress', () => {
    // Captured at 11:31:55 UTC: the 11:30 row is still in progress.
    const now = 1794742315000;
    const points = parseOkxOi(okxOi, now);
    expect(points).toHaveLength(5);
    // The 11:15 row holds the open interest, in coins, as of 11:30.
    expect(points[0]).toEqual({ t: 1794742200000, oi: 32722.8934000001291 });
    expect(points.every((p) => p.t <= now)).toBe(true);
  });

  it('reads taker sell then buy turnover, matching the candle', () => {
    const points = parseOkxTaker(okxTaker);
    const p = points.find((x) => x.t === 1794741300000);
    expect(p).toEqual({ t: 1794741300000, sell: 18510972.69791000057, buy: 16269809.18428000063 });
    // Buy + sell is the same bar's USDT turnover from the candle feed.
    expect((p!.buy + p!.sell) / 34780781.88219).toBeCloseTo(1, 4);
  });

  it('fails loudly on an error payload', () => {
    expect(() => parseOkxTickers({ code: '50011', msg: 'Too Many Requests', data: [] })).toThrow(FetchError);
  });
});

describe('Pionex', () => {
  const tickers = parsePionexTickers(pionexTickers);

  it('keeps USDT-quoted perpetuals only', () => {
    expect(tickers.map((t) => t.symbol).sort()).toEqual([
      'BTC_USDT_PERP',
      'ETH_USDT_PERP',
      'MSTRX_USDT_PERP',
      'XRP_USDT_PERP',
    ]);
  });

  it('uses the reported quote amount as turnover', () => {
    const btc = bySymbol(tickers, 'BTC_USDT_PERP');
    expect(btc.base).toBe('BTC');
    expect(btc.turnoverApprox).toBe(false);
    expect(btc.turnover24h).toBeCloseTo(8292974238.93, 1);
    // Magnitude check against volume × price: same order, within 5%.
    expect(btc.turnover24h / (127980.2408 * 64355.6)).toBeGreaterThan(0.95);
    expect(btc.turnover24h / (127980.2408 * 64355.6)).toBeLessThan(1.05);
    expect(btc.changePct).toBeCloseTo(((64355.6 - 67316.6) / 67316.6) * 100, 6);
  });

  it('prices kline volume at the bar typical price', () => {
    const bars = parsePionexKlines(pionexKlines);
    expect(bars).toHaveLength(3);
    const typical = (64615.1 + 64143.5 + 64430.0) / 3;
    expect(bars[1]).toMatchObject({ t: 1794722400000, open: 64481.3, close: 64430.0, takerBuy: null });
    expect(bars[1].turnover).toBeCloseTo(2840.5244 * typical, 3);
  });

  it('fails loudly on an error payload', () => {
    expect(() => parsePionexTickers({ result: false, code: 'TRADE_INVALID_SYMBOL' })).toThrow(FetchError);
  });
});

describe('Binance', () => {
  const tickers = parseBinanceTickers(binanceTickers);

  it('drops dated contracts, USDC pairs and tickers that stopped updating', () => {
    expect(tickers.map((t) => t.symbol)).toEqual(['BTCUSDT', '1000PEPEUSDT']);
  });

  it('reads price, change and USDT turnover directly', () => {
    const btc = bySymbol(tickers, 'BTCUSDT');
    expect(btc).toEqual({
      symbol: 'BTCUSDT',
      base: 'BTC',
      price: 64355.6,
      changePct: -4.398,
      turnover24h: 20125128900.11,
      turnoverApprox: false,
    });
    expect(bySymbol(tickers, '1000PEPEUSDT').base).toBe('1000PEPE');
  });

  it('reads quote volume and the taker-buy split from klines', () => {
    const bars = parseBinanceKlines(binanceKlines);
    expect(bars[1]).toEqual({
      t: 1794722400000,
      open: 64478.7,
      close: 64425.3,
      turnover: 987200455.9,
      takerBuy: 476100000.3,
    });
  });

  it('reads open interest in coins at each snapshot time', () => {
    const points = parseBinanceOi(binanceOi);
    expect(points).toHaveLength(3);
    expect(points[2]).toEqual({ t: 1794741300000, oi: 82224.201 });
  });

  it('fails loudly on the region-block payload', () => {
    expect(() => parseBinanceTickers({ code: 0, msg: 'Service unavailable from a restricted location' })).toThrow(
      FetchError,
    );
  });
});

describe('CoinGecko trending', () => {
  it('reads symbol, rank, price and USD change', () => {
    const coins = parseTrending(trending);
    expect(coins).toHaveLength(3);
    expect(coins[1]).toMatchObject({ id: 'kava', symbol: 'KAVA', name: 'Kava', rank: 472 });
    expect(coins[1].priceUsd).toBeCloseTo(0.036468671, 8);
    expect(coins[1].changePct).toBeCloseTo(-45.92, 2);
  });
});

describe('candles for the chart', () => {
  it('reads OHLC and USDT turnover from OKX, oldest first', async () => {
    const { parseOkxCandleSeries } = await import('../src/lib/candles');
    const bars = parseOkxCandleSeries(okxCandles);
    expect(bars.map((b) => b.t)).toEqual([1794739500000, 1794740400000, 1794741300000, 1794742200000]);
    expect(bars[2]).toEqual({ t: 1794741300000, open: 65285, high: 65525, low: 65277.7, close: 65419.3, turnover: 34780781.88219 });
  });

  it('reads OHLC and quote volume from Binance klines', async () => {
    const { parseBinanceCandles } = await import('../src/lib/candles');
    const bars = parseBinanceCandles(binanceKlines);
    expect(bars[1]).toEqual({ t: 1794722400000, open: 64478.7, high: 64614, low: 64136.8, close: 64425.3, turnover: 987200455.9 });
  });

  it('finds the same coin across naming conventions, and reports when an exchange has none', async () => {
    const { symbolFor } = await import('../src/lib/candles');
    const binance = new Set(['BTCUSDT', '1000PEPEUSDT']);
    const okx = new Set(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP', 'NVDA-USDT-SWAP']);
    expect(symbolFor('binance', 'BTC', binance)).toBe('BTCUSDT');
    expect(symbolFor('binance', 'PEPE', binance)).toBe('1000PEPEUSDT');
    expect(symbolFor('okx', '1000PEPE', okx)).toBe('PEPE-USDT-SWAP');
    expect(symbolFor('binance', 'NVDA', binance)).toBeNull();
    // An exchange that has not answered yet gets the plain name as a best guess.
    expect(symbolFor('binance', 'NVDA', new Set())).toBe('NVDAUSDT');
  });
});
