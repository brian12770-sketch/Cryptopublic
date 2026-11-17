import type { Adapter, Bar, OiPoint, Ticker } from '../types';
import { getJson, isRecord, num, shapeError } from '../lib/http';

const BASE = 'https://fapi.binance.com';

/** Plain USDT perpetuals only: no dated contracts (BTCUSDT_261225), no USDC pairs. */
const USDT_PERP = /^[A-Z0-9]+USDT$/;

/** A symbol whose ticker stopped updating this long ago is delisted or halted. */
const STALE_MS = 60 * 60 * 1000;

export function parseBinanceTickers(json: unknown): Ticker[] {
  if (!Array.isArray(json)) throw shapeError('幣安行情');
  const rows = json.filter(isRecord);
  // Compare against the newest closeTime in the payload, not the device clock.
  const newest = rows.reduce((m, r) => Math.max(m, num(r.closeTime) || 0), 0);
  const out: Ticker[] = [];
  for (const r of rows) {
    const symbol = r.symbol;
    if (typeof symbol !== 'string' || !USDT_PERP.test(symbol)) continue;
    const price = num(r.lastPrice);
    const changePct = num(r.priceChangePercent);
    const turnover24h = num(r.quoteVolume);
    const closeTime = num(r.closeTime);
    if (!(price > 0) || !Number.isFinite(changePct) || !(turnover24h > 0)) continue;
    if (Number.isFinite(closeTime) && newest - closeTime > STALE_MS) continue;
    out.push({
      symbol,
      base: symbol.slice(0, -4),
      price,
      changePct,
      turnover24h,
      turnoverApprox: false,
    });
  }
  if (out.length === 0) throw shapeError('幣安行情');
  return out;
}

/** Best bid and ask per symbol from /fapi/v1/ticker/bookTicker. */
export function parseBinanceBook(json: unknown): Map<string, { bid: number; ask: number }> {
  if (!Array.isArray(json)) throw shapeError('幣安買賣價');
  const out = new Map<string, { bid: number; ask: number }>();
  for (const r of json) {
    if (!isRecord(r) || typeof r.symbol !== 'string') continue;
    const bid = num(r.bidPrice);
    const ask = num(r.askPrice);
    if (bid > 0 && ask >= bid) out.set(r.symbol, { bid, ask });
  }
  return out;
}

export function parseBinanceKlines(json: unknown): Bar[] {
  if (!Array.isArray(json)) throw shapeError('幣安 K 線');
  const out: Bar[] = [];
  for (const row of json) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]);
    const open = num(row[1]);
    const high = num(row[2]);
    const low = num(row[3]);
    const close = num(row[4]);
    const turnover = num(row[7]); // quote asset volume, in USDT
    const takerBuy = num(row[10]); // taker buy quote asset volume, in USDT
    if (![t, open, high, low, close, turnover].every(Number.isFinite)) continue;
    out.push({ t, open, high, low, close, turnover, takerBuy: Number.isFinite(takerBuy) ? takerBuy : null });
  }
  return out;
}

/** Each record is the open interest at its timestamp, which sits on a 15-minute boundary. */
export function parseBinanceOi(json: unknown): OiPoint[] {
  if (!Array.isArray(json)) throw shapeError('幣安未平倉量');
  const out: OiPoint[] = [];
  for (const r of json) {
    if (!isRecord(r)) continue;
    const t = num(r.timestamp);
    const oi = num(r.sumOpenInterest); // in coins
    if (Number.isFinite(t) && oi > 0) out.push({ t, oi });
  }
  return out;
}

export const binance: Adapter = {
  id: 'binance',
  name: '幣安',
  pollMs: 5000,
  turnoverNote: '交易所直接提供的 USDT 成交額',
  concurrency: { bars: 3, stats: 3 },
  async fetchTickers(signal) {
    // The 24h ticker has no bid and ask; the book ticker does. A failed book
    // request costs only the spread, so it never fails the tickers.
    const [tickers, book] = await Promise.all([
      getJson(`${BASE}/fapi/v1/ticker/24hr`, signal).then(parseBinanceTickers),
      getJson(`${BASE}/fapi/v1/ticker/bookTicker`, signal)
        .then(parseBinanceBook)
        .catch(() => new Map<string, { bid: number; ask: number }>()),
    ]);
    return tickers.map((t) => ({ ...t, ...book.get(t.symbol) }));
  },
  async fetchBars(symbol, signal) {
    const url = `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=300`;
    return parseBinanceKlines(await getJson(url, signal));
  },
  async fetchOi(symbol, signal) {
    const url = `${BASE}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=15m&limit=8`;
    return parseBinanceOi(await getJson(url, signal));
  },
};
