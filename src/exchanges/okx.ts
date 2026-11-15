import type { Adapter, HourBar, Ticker } from '../types';
import { getJson, isRecord, num, shapeError } from '../lib/http';

const BASE = 'https://www.okx.com';
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
    });
  }
  if (out.length === 0) throw shapeError('OKX 行情');
  return out;
}

export function parseOkxCandles(json: unknown): HourBar[] {
  const out: HourBar[] = [];
  for (const row of rowsOf(json, 'OKX K 線')) {
    if (!Array.isArray(row)) continue;
    const t = num(row[0]);
    const turnover = num(row[7]); // volCcyQuote, in USDT
    if (Number.isFinite(t) && Number.isFinite(turnover)) out.push({ t, turnover });
  }
  return out;
}

export const okx: Adapter = {
  id: 'okx',
  name: 'OKX',
  pollMs: 5000,
  turnoverNote: '以成交幣數 × 24 小時代表價換算，為近似值',
  async fetchTickers(signal) {
    return parseOkxTickers(await getJson(`${BASE}/api/v5/market/tickers?instType=SWAP`, signal));
  },
  async fetchHourBars(symbol, signal) {
    const url = `${BASE}/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=1H&limit=170`;
    return parseOkxCandles(await getJson(url, signal));
  },
};
