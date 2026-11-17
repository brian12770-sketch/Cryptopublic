/** 8.29B / 568.2M / 13.7M / 920K — USDT turnover in compact form. */
export function fmtTurnover(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e8) return `${(v / 1e6).toFixed(0)}M`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}

/** Price with enough significant digits for both BTC and sub-cent coins. */
export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (abs >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return v.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

export function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 10 ? 1 : 2;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** Taker buy/sell ratio: two decimals, since it lives close to 1. */
export function fmtTaker(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function fmtRatio(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;
}

const clock = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const hourMinute = new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function fmtClock(ms: number): string {
  return clock.format(ms);
}

export function fmtHourMinute(ms: number): string {
  return hourMinute.format(ms);
}

/** Bid-ask spread as a share of the mid price, in percent; NaN when either side is missing. */
export function spreadPct(bid: number | undefined, ask: number | undefined): number {
  if (bid === undefined || ask === undefined || !(bid > 0) || !(ask >= bid)) return NaN;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

export function fmtSpread(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  return `${pct < 0.1 ? pct.toFixed(3) : pct.toFixed(2)}%`;
}

