import { getJson, isRecord, num, shapeError } from './http';

export type Interval = '15m' | '1h' | '4h' | '1d';
export type CandleSource = 'binance' | 'okx';

export interface Candle {
  /** Bar open time, ms since epoch. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** USDT traded in the bar. */
  turnover: number;
}

export const INTERVALS: { id: Interval; label: string }[] = [
  { id: '15m', label: '15 分' },
  { id: '1h', label: '1 時' },
  { id: '4h', label: '4 時' },
  { id: '1d', label: '日' },
];

export const SOURCE_NAME: Record<CandleSource, string> = { binance: '幣安', okx: 'OKX' };

const OKX_BAR: Record<Interval, string> = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };

function candle(t: number, o: number, h: number, l: number, c: number, turnover: number): Candle | null {
  if (![t, o, h, l, c, turnover].every(Number.isFinite) || !(o > 0)) return null;
  return { t, open: o, high: h, low: l, close: c, turnover };
}

/** Binance kline rows: [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...], oldest first. */
export function parseBinanceCandles(json: unknown): Candle[] {
  if (!Array.isArray(json)) throw shapeError('幣安 K 線');
  const out: Candle[] = [];
  for (const row of json) {
    if (!Array.isArray(row)) continue;
    const c = candle(num(row[0]), num(row[1]), num(row[2]), num(row[3]), num(row[4]), num(row[7]));
    if (c) out.push(c);
  }
  if (out.length === 0) throw shapeError('幣安 K 線');
  return out.sort((a, b) => a.t - b.t);
}

/** OKX candle rows: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm], newest first. */
export function parseOkxCandleSeries(json: unknown): Candle[] {
  if (!isRecord(json) || json.code !== '0' || !Array.isArray(json.data)) throw shapeError('OKX K 線');
  const out: Candle[] = [];
  for (const row of json.data) {
    if (!Array.isArray(row)) continue;
    const c = candle(num(row[0]), num(row[1]), num(row[2]), num(row[3]), num(row[4]), num(row[7]));
    if (c) out.push(c);
  }
  if (out.length === 0) throw shapeError('OKX K 線');
  return out.sort((a, b) => a.t - b.t);
}

/** Recent candles, oldest first, including the bar still forming. */
export async function fetchCandles(
  source: CandleSource,
  symbol: string,
  interval: Interval,
  signal: AbortSignal,
): Promise<Candle[]> {
  const id = encodeURIComponent(symbol);
  if (source === 'binance') {
    return parseBinanceCandles(
      await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${id}&interval=${interval}&limit=500`, signal),
    );
  }
  return parseOkxCandleSeries(
    await getJson(`https://www.okx.com/api/v5/market/candles?instId=${id}&bar=${OKX_BAR[interval]}&limit=300`, signal),
  );
}

/** Coins quoted in lots on one exchange and singly on another, e.g. 1000PEPE and PEPE. */
const stripLot = (base: string) => base.replace(/^10{3,}/, '');

/**
 * The contract for `base` on `source`, or null when that exchange lists none.
 * `listed` is every USDT perpetual the exchange reported; when it is empty the
 * exchange has not answered, so the plain name is returned as a best guess.
 */
export function symbolFor(source: CandleSource, base: string, listed: ReadonlySet<string>): string | null {
  const coin = stripLot(base);
  const candidates =
    source === 'binance'
      ? [`${base}USDT`, `${coin}USDT`, `1000${coin}USDT`, `1000000${coin}USDT`]
      : [`${base}-USDT-SWAP`, `${coin}-USDT-SWAP`];
  if (listed.size === 0) return candidates[0];
  return candidates.find((s) => listed.has(s)) ?? null;
}
