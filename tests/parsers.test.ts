import { describe, expect, it } from 'vitest';
import { parseBinanceKlines, parseBinanceTickers } from '../src/exchanges/binance';
import { parseOkxCandles, parseOkxTickers } from '../src/exchanges/okx';
import { parsePionexKlines, parsePionexTickers } from '../src/exchanges/pionex';
import { parseTrending } from '../src/lib/trending';
import { FetchError } from '../src/lib/http';

// OKX, Pionex and CoinGecko fixtures are real responses captured 2026-11-15.
// Binance fixtures follow its published schema: the API refused this build
// machine's region, so they were written by hand, not captured.
import okxTickers from './fixtures/okx-tickers.json';
import okxCandles from './fixtures/okx-candles.json';
import pionexTickers from './fixtures/pionex-tickers.json';
import pionexKlines from './fixtures/pionex-klines.json';
import binanceTickers from './fixtures/binance-tickers.json';
import binanceKlines from './fixtures/binance-klines.json';
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

  it('reads USDT turnover from candles', () => {
    const bars = parseOkxCandles(okxCandles);
    expect(bars).toHaveLength(3);
    expect(bars[1]).toEqual({ t: 1794722400000, turnover: 345229678.07008 });
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
    expect(bars[1].t).toBe(1794722400000);
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

  it('reads quote volume from klines', () => {
    const bars = parseBinanceKlines(binanceKlines);
    expect(bars[1]).toEqual({ t: 1794722400000, turnover: 987200455.9 });
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
