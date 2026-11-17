export type ExchangeId = 'binance' | 'okx' | 'pionex';

/** One USDT perpetual contract, normalised across exchanges. */
export interface Ticker {
  /** Exchange-native symbol, e.g. BTCUSDT / BTC-USDT-SWAP / BTC_USDT_PERP. */
  symbol: string;
  /** Base asset shown to the reader, e.g. BTC. */
  base: string;
  price: number;
  /** 24h change in percent (rolling 24h window on all three exchanges). */
  changePct: number;
  /** 24h turnover in USDT. */
  turnover24h: number;
  /** true when the exchange does not report USDT turnover and we derived it. */
  turnoverApprox: boolean;
  /** Best bid and ask; NaN when the exchange did not supply them. */
  bid?: number;
  ask?: number;
}

/** One 15-minute candle reduced to what the metrics need. */
export interface Bar {
  /** Bar open time, ms since epoch. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Turnover in USDT for the bar. */
  turnover: number;
  /** USDT bought by takers in the bar; null when the candle feed has no split. */
  takerBuy: number | null;
}

/** Open interest, in coins, as it stood at time `t`. */
export interface OiPoint {
  t: number;
  oi: number;
}

/** Taker buy and sell turnover in USDT for the 15-minute bar opening at `t`. */
export interface TakerPoint {
  t: number;
  buy: number;
  sell: number;
}

export interface Adapter {
  id: ExchangeId;
  name: string;
  /** Milliseconds between ticker polls. */
  pollMs: number;
  /** How the 24h turnover is obtained, shown to the reader. */
  turnoverNote: string;
  /** Parallel requests allowed for candles, and for the slower statistics endpoints. */
  concurrency: { bars: number; stats: number };
  fetchTickers(signal: AbortSignal): Promise<Ticker[]>;
  /** 15-minute bars, any order, may include the bar still in progress. */
  fetchBars(symbol: string, signal: AbortSignal): Promise<Bar[]>;
  /** Open-interest snapshots on 15-minute boundaries. Absent when the exchange has none. */
  fetchOi?(symbol: string, signal: AbortSignal): Promise<OiPoint[]>;
  /** Taker split per bar, for exchanges whose candles do not carry it. */
  fetchTaker?(symbol: string, signal: AbortSignal): Promise<TakerPoint[]>;
}

/**
 * A derived value and, when there is none, why. "Not computed yet", "not enough
 * data to compute" and "the request failed" must stay distinguishable.
 */
export type Cell =
  | { kind: 'ok'; value: number }
  | { kind: 'pending' }
  | { kind: 'insufficient' }
  | { kind: 'failed'; message: string };

/** Everything derived for one contract from its last closed 15-minute bar. */
export interface Metrics {
  /** Open time of the bar these figures describe; one bar behind while the newest is still loading. */
  barTime: number;
  /** Relative volume: the bar's turnover over the median of the prior 3 days of bars. */
  rvol: Cell;
  /** The bar's own price change, open to close, in percent. */
  ret15: Cell;
  /** Taker buy turnover divided by taker sell turnover in the bar. */
  taker: Cell;
  /** Change in open interest across the bar, in percent. */
  oi15: Cell;
  /** Change in open interest across the hour ending at the bar's close, in percent. */
  oi1h: Cell;
  /** Time of the open-interest snapshot the two changes end at; it can trail the bar by 15 minutes. */
  oiTime: number | null;
  /** Price change over each look-back window ending at the bar's close, in percent. */
  lookback: Record<Horizon, Cell>;
}

/** Look-back windows for the relative-strength ranking. */
export type Horizon = '1h' | '4h' | '24h';

export type Mode = 'rvol' | 'oi' | 'taker' | 'rs' | 'change';
export type UpColor = 'green' | 'red';
