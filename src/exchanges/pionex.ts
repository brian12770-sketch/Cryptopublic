import type { Adapter, HourBar, Ticker } from '../types';
import { getJson, isRecord, num, shapeError } from '../lib/http';

// Pionex's API sends no CORS headers (verified 2026-11-15), so a browser cannot
// call it directly. Requests go through the same-origin proxy in
// functions/api/pionex, or the Vite dev-server proxy while developing.
const BASE = import.meta.env?.VITE_PIONEX_BASE ?? '/api/pionex';
const SUFFIX = '_USDT_PERP';

function dataOf(json: unknown, what: string): Record<string, unknown> {
  if (!isRecord(json) || json.result !== true || !isRecord(json.data)) throw shapeError(what);
  return json.data;
}

export function parsePionexTickers(json: unknown): Ticker[] {
  const rows = dataOf(json, 'Pionex 行情').tickers;
  if (!Array.isArray(rows)) throw shapeError('Pionex 行情');
  const out: Ticker[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const symbol = r.symbol;
    // Skip contracts quoted in BTC/ETH/etc.: their amount is not in USDT.
    if (typeof symbol !== 'string' || !symbol.endsWith(SUFFIX)) continue;
    const price = num(r.close);
    const open = num(r.open);
    const turnover24h = num(r.amount); // quote amount, in USDT
    if (!(price > 0) || !(open > 0) || !(turnover24h > 0)) continue;
    out.push({
      symbol,
      base: symbol.slice(0, -SUFFIX.length),
      price,
      changePct: ((price - open) / open) * 100,
      turnover24h,
      turnoverApprox: false,
    });
  }
  if (out.length === 0) throw shapeError('Pionex 行情');
  return out;
}

export function parsePionexKlines(json: unknown): HourBar[] {
  const rows = dataOf(json, 'Pionex K 線').klines;
  if (!Array.isArray(rows)) throw shapeError('Pionex K 線');
  const out: HourBar[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const t = num(r.time);
    const baseVol = num(r.volume);
    const high = num(r.high);
    const low = num(r.low);
    const close = num(r.close);
    // Klines carry base volume only; turnover is volume × the bar's typical price.
    const turnover = baseVol * ((high + low + close) / 3);
    if (Number.isFinite(t) && Number.isFinite(turnover)) out.push({ t, turnover });
  }
  return out;
}

export const pionex: Adapter = {
  id: 'pionex',
  name: 'Pionex',
  pollMs: 5000,
  turnoverNote: '交易所直接提供的 USDT 成交額',
  async fetchTickers(signal) {
    return parsePionexTickers(await getJson(`${BASE}/market/tickers?type=PERP`, signal));
  },
  async fetchHourBars(symbol, signal) {
    const url = `${BASE}/market/klines?symbol=${encodeURIComponent(symbol)}&interval=60M&limit=170`;
    return parsePionexKlines(await getJson(url, signal));
  },
};
