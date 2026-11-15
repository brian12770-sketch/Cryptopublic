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
}

/** One hourly candle reduced to what the heat calculation needs. */
export interface HourBar {
  /** Bar open time, ms since epoch. */
  t: number;
  /** Turnover in USDT for the bar. */
  turnover: number;
}

export interface Adapter {
  id: ExchangeId;
  name: string;
  /** Milliseconds between ticker polls. */
  pollMs: number;
  /** How the 24h turnover is obtained, shown to the reader. */
  turnoverNote: string;
  fetchTickers(signal: AbortSignal): Promise<Ticker[]>;
  /** Hourly bars, any order, may include the bar still in progress. */
  fetchHourBars(symbol: string, signal: AbortSignal): Promise<HourBar[]>;
}

export interface Heat {
  /** Last closed hour's turnover divided by the baseline median. */
  ratio: number;
  /** Open time of the bar the ratio describes. */
  barTime: number;
  /** Number of bars in the baseline. */
  baselineN: number;
}

/** Why a symbol has no heat value. The two cases must stay distinguishable. */
export type HeatState =
  | { kind: 'ok'; heat: Heat }
  | { kind: 'pending' }
  | { kind: 'insufficient' }
  | { kind: 'failed'; message: string };

export type Mode = 'heat' | 'change';
export type UpColor = 'green' | 'red';
