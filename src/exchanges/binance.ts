import type { Adapter, HourBar, Ticker } from '../types';
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

export function parseBinanceKlines(json: unknown): HourBar[] {
  if (!Array.isArray(json)) throw shapeError('幣安 K 線');
  const out: HourBar[] = [];
  for (const row of json) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]);
    const turnover = num(row[7]); // quote asset volume, in USDT
    if (Number.isFinite(t) && Number.isFinite(turnover)) out.push({ t, turnover });
  }
  return out;
}

export const binance: Adapter = {
  id: 'binance',
  name: '幣安',
  pollMs: 5000,
  turnoverNote: '交易所直接提供的 USDT 成交額',
  async fetchTickers(signal) {
    return parseBinanceTickers(await getJson(`${BASE}/fapi/v1/ticker/24hr`, signal));
  },
  async fetchHourBars(symbol, signal) {
    const url = `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=170`;
    return parseBinanceKlines(await getJson(url, signal));
  },
};
