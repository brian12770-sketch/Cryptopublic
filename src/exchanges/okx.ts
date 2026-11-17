import type { Adapter, Bar, OiPoint, TakerPoint, Ticker } from '../types';
import { BAR_MS } from '../lib/metrics';
import { getJson, isRecord, num, shapeError } from '../lib/http';

const BASE = 'https://www.okx.com';
// OKX's statistics endpoints send no CORS headers, so they go through the
// Worker's proxy (server/okxStats.ts), or the Vite dev-server proxy.
const STATS = import.meta.env?.VITE_OKX_STATS_BASE ?? '/api/okx';
const SUFFIX = '-USDT-SWAP';

function rowsOf(json: unknown, what: string): unknown[] {
  if (!isRecord(json) || json.code !== '0' || !Array.isArray(json.data)) throw shapeError(what);
  return json.data;
}

export function parseOkxTickers(json: unknown): Ticker[] {
  const out: Ticker[] = [];
  for (const r of rowsOf(json, 'OKX 行情')) {
    if (!isRecord(r)) continue;
    const symbol = r.instId;
    // Skip coin-margined contracts (BTC-USD-SWAP): their volume unit differs.
    if (typeof symbol !== 'string' || !symbol.endsWith(SUFFIX)) continue;
    const price = num(r.last);
    const open = num(r.open24h);
    const high = num(r.high24h);
    const low = num(r.low24h);
    // For swaps volCcy24h is in the base coin (verified 2026-11-15:
    // vol24h × ctVal = volCcy24h for BTC, ETH and DOGE). OKX gives no USDT
    // figure on the ticker, so turnover is base volume × a typical 24h price.
    const baseVol = num(r.volCcy24h);
    if (!(price > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(baseVol > 0)) continue;
    const typical = (open + high + low + price) / 4;
    out.push({
      symbol,
      base: symbol.slice(0, -SUFFIX.length),
      price,
      changePct: ((price - open) / open) * 100,
      turnover24h: baseVol * typical,
      turnoverApprox: true,
      bid: num(r.bidPx),
      ask: num(r.askPx),
    });
  }
  if (out.length === 0) throw shapeError('OKX 行情');
  return out;
}

export function parseOkxCandles(json: unknown): Bar[] {
  const out: Bar[] = [];
  for (const row of rowsOf(json, 'OKX K 線')) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]);
    const open = num(row[1]);
    const high = num(row[2]);
    const low = num(row[3]);
    const close = num(row[4]);
    const turnover = num(row[7]); // volCcyQuote, in USDT
    if (![t, open, high, low, close, turnover].every(Number.isFinite)) continue;
    // OKX candles carry no taker split; it comes from the taker-volume series.
    out.push({ t, open, high, low, close, turnover, takerBuy: null });
  }
  return out;
}

/**
 * Rows are [ts, oi (contracts), oiCcy (coins), oiUsd]. `ts` is the open of a
 * 15-minute period and the value is the open interest at that period's close
 * (verified 2026-11-15: the row for the period still in progress repeats the
 * previous row's value). So each row is re-stamped with the close time, and the
 * in-progress row is dropped.
 */
export function parseOkxOi(json: unknown, now: number): OiPoint[] {
  const out: OiPoint[] = [];
  for (const row of rowsOf(json, 'OKX 未平倉量')) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]) + BAR_MS;
    const oi = num(row[2]);
    if (Number.isFinite(t) && t <= now && oi > 0) out.push({ t, oi });
  }
  return out;
}

/**
 * Rows are [ts, sellVol, buyVol] in USDT (unit=2). The column order was checked
 * on 2026-11-15 against 99 bars each of BTC and SOL: (col 2 − col 1) correlates
 * +0.61 with the bar's price change, so column 2 is the buy side.
 */
export function parseOkxTaker(json: unknown): TakerPoint[] {
  const out: TakerPoint[] = [];
  for (const row of rowsOf(json, 'OKX 主動買賣量')) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]);
    const sell = num(row[1]);
    const buy = num(row[2]);
    if ([t, sell, buy].every(Number.isFinite)) out.push({ t, buy, sell });
  }
  return out;
}

export const okx: Adapter = {
  id: 'okx',
  name: 'OKX',
  pollMs: 5000,
  turnoverNote: '以成交幣數 × 24 小時代表價換算，為近似值',
  concurrency: { bars: 3, stats: 2 },
  async fetchTickers(signal) {
    return parseOkxTickers(await getJson(`${BASE}/api/v5/market/tickers?instType=SWAP`, signal));
  },
  async fetchBars(symbol, signal) {
    const url = `${BASE}/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=15m&limit=300`;
    return parseOkxCandles(await getJson(url, signal));
  },
  async fetchOi(symbol, signal) {
    const url = `${STATS}/oi?instId=${encodeURIComponent(symbol)}`;
    return parseOkxOi(await getJson(url, signal), Date.now());
  },
  async fetchTaker(symbol, signal) {
    const url = `${STATS}/taker?instId=${encodeURIComponent(symbol)}`;
    return parseOkxTaker(await getJson(url, signal));
  },
};
