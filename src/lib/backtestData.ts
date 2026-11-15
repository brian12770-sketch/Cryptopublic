// Downloads the history a backtest needs, straight from the exchange, in the
// reader's browser. Public market data only.

import type { Row } from '../../backtest/engine';
import { getJson, isRecord, num, shapeError } from './http';
import { BAR_MS } from './metrics';

export type DataSource = 'binance' | 'okx';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Bars fetched before the test window so the first bar already has a full RVOL baseline. */
export const WARMUP_MS = 3 * DAY_MS;
/** Contracts considered when ranking by a past day's turnover. */
const CANDIDATES = 100;

export interface Dataset {
  source: DataSource;
  /** Test window, [from, to), in ms. Rows start WARMUP_MS before `from`. */
  from: number;
  to: number;
  /** Contract id -> bars, oldest first. */
  rows: Map<string, Row[]>;
  /** Whether the rows carry taker flow, open interest, and funding. */
  has: { taker: boolean; oi: boolean; funding: boolean };
  /** How the contracts were chosen, for display. */
  universeNote: string;
  /** Things that went wrong without stopping the download; shown to the reader. */
  warnings: string[];
}

export interface Progress {
  done: number;
  total: number;
  label: string;
}

/** What each source can provide. OKX keeps open interest and taker flow too briefly to be useful here. */
export const SOURCES: Record<DataSource, { name: string; maxDays: number; taker: boolean; oiDays: number; note: string }> = {
  binance: {
    name: '幣安',
    maxDays: 180,
    taker: true,
    oiDays: 30,
    note: 'K 線含主動買賣量；OI 歷史只有最近 30 天。',
  },
  okx: {
    name: 'OKX',
    maxDays: 30,
    taker: false,
    oiDays: 0,
    note: '只有 K 線，買賣比與 OI 條件無法使用；下載較慢，所以期間上限 30 天。',
  },
};

// ---------- pacing ----------

/** Spaces requests out so a download stays inside the exchange's rate limit. */
function pacer(perSecond: number) {
  let next = 0;
  return async (signal: AbortSignal) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    signal.throwIfAborted();
  };
}

async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}

// ---------- Binance ----------

const BINANCE = 'https://fapi.binance.com';
// Klines with limit 1500 cost 10 weight each against 2400 a minute.
const binancePace = pacer(3);

async function binanceDayTurnover(symbol: string, dayStart: number, signal: AbortSignal): Promise<number> {
  await binancePace(signal);
  const json = await getJson(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&startTime=${dayStart}&limit=1`, signal);
  if (!Array.isArray(json)) throw shapeError('幣安日 K 線');
  const row = json[0];
  // A contract that was not listed yet returns a later day, or nothing.
  return Array.isArray(row) && num(row[0]) === dayStart ? num(row[7]) : NaN;
}

export function parseBinanceRows(json: unknown): Row[] {
  if (!Array.isArray(json)) throw shapeError('幣安 K 線');
  const out: Row[] = [];
  for (const r of json) {
    if (!Array.isArray(r)) continue;
    const t = num(r[0]);
    const open = num(r[1]);
    const close = num(r[4]);
    const turnover = num(r[7]);
    const takerBuy = num(r[10]);
    if (![t, open, close, turnover].every(Number.isFinite)) continue;
    out.push({ t, open, close, turnover, oi: NaN, takerBuy, takerSell: turnover - takerBuy, funding: NaN });
  }
  return out;
}

async function binanceRows(symbol: string, from: number, to: number, signal: AbortSignal): Promise<Row[]> {
  const out: Row[] = [];
  let start = from;
  while (start < to) {
    await binancePace(signal);
    const page = parseBinanceRows(
      await getJson(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${start}&endTime=${to - 1}&limit=1500`, signal),
    );
    if (page.length === 0) break;
    out.push(...page);
    start = page[page.length - 1].t + BAR_MS;
    if (page.length < 1500) break;
  }
  return out;
}

/** Funding settlements as Map(bar open time -> rate). Binance stamps them a few ms off the hour. */
export function parseBinanceFunding(json: unknown): Map<number, number> {
  if (!Array.isArray(json)) throw shapeError('幣安資金費率');
  const out = new Map<number, number>();
  for (const r of json) {
    if (!isRecord(r)) continue;
    const t = Math.round(num(r.fundingTime) / BAR_MS) * BAR_MS;
    const rate = num(r.fundingRate);
    if (Number.isFinite(t) && Number.isFinite(rate)) out.set(t, rate);
  }
  return out;
}

async function binanceFunding(symbol: string, from: number, to: number, signal: AbortSignal): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let start = from;
  while (start < to) {
    await binancePace(signal);
    const page = parseBinanceFunding(
      await getJson(`${BINANCE}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&endTime=${to}&limit=1000`, signal),
    );
    if (page.size === 0) break;
    let newest = start;
    for (const [t, rate] of page) {
      out.set(t, rate);
      newest = Math.max(newest, t);
    }
    if (page.size < 1000) break;
    start = newest + 1;
  }
  return out;
}

/** Open interest in coins as Map(snapshot time -> oi). Each record is the level at its timestamp. */
export function parseBinanceOiHistory(json: unknown): Map<number, number> {
  if (!Array.isArray(json)) throw shapeError('幣安未平倉量');
  const out = new Map<number, number>();
  for (const r of json) {
    if (!isRecord(r)) continue;
    const t = num(r.timestamp);
    const oi = num(r.sumOpenInterest);
    if (Number.isFinite(t) && oi > 0) out.set(t, oi);
  }
  return out;
}

/** Binance serves open-interest history for the last 30 days only; stay just inside that. */
const OI_REACH_MS = 29 * DAY_MS;

async function binanceOi(symbol: string, from: number, to: number, signal: AbortSignal): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const span = 500 * BAR_MS;
  const first = Math.max(from, Math.ceil((Date.now() - OI_REACH_MS) / BAR_MS) * BAR_MS);
  for (let start = first; start < to; start += span) {
    await binancePace(signal);
    const end = Math.min(start + span, to);
    const page = parseBinanceOiHistory(
      await getJson(`${BINANCE}/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=500&startTime=${start}&endTime=${end}`, signal),
    );
    for (const [t, oi] of page) out.set(t, oi);
  }
  return out;
}

// ---------- OKX ----------

const OKX = 'https://www.okx.com/api/v5';
const okxPace = pacer(8);

function okxData(json: unknown, what: string): unknown[] {
  if (!isRecord(json) || json.code !== '0' || !Array.isArray(json.data)) throw shapeError(what);
  return json.data;
}

async function okxDayTurnover(instId: string, dayStart: number, signal: AbortSignal): Promise<number> {
  await okxPace(signal);
  const rows = okxData(
    await getJson(`${OKX}/market/history-candles?instId=${instId}&bar=1Dutc&limit=1&after=${dayStart + DAY_MS}`, signal),
    'OKX 日 K 線',
  );
  const row = rows[0];
  return Array.isArray(row) && num(row[0]) === dayStart ? num(row[7]) : NaN;
}

export function parseOkxRows(json: unknown): Row[] {
  const out: Row[] = [];
  for (const r of okxData(json, 'OKX K 線')) {
    if (!Array.isArray(r) || r[8] !== '1') continue; // closed candles only
    const t = num(r[0]);
    const open = num(r[1]);
    const close = num(r[4]);
    const turnover = num(r[7]);
    if (![t, open, close, turnover].every(Number.isFinite)) continue;
    out.push({ t, open, close, turnover, oi: NaN, takerBuy: NaN, takerSell: NaN, funding: NaN });
  }
  return out;
}

async function okxRows(instId: string, from: number, to: number, signal: AbortSignal): Promise<Row[]> {
  const out: Row[] = [];
  let after = to;
  while (after > from) {
    await okxPace(signal);
    const page = parseOkxRows(
      await getJson(`${OKX}/market/history-candles?instId=${instId}&bar=15m&limit=100&after=${after}`, signal),
    );
    if (page.length === 0) break;
    for (const r of page) if (r.t >= from && r.t < to) out.push(r);
    after = Math.min(...page.map((r) => r.t));
  }
  return out.sort((a, b) => a.t - b.t);
}

async function okxFunding(instId: string, from: number, to: number, signal: AbortSignal): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let after = to;
  while (after > from) {
    await okxPace(signal);
    const rows = okxData(await getJson(`${OKX}/public/funding-rate-history?instId=${instId}&limit=100&after=${after}`, signal), 'OKX 資金費率');
    if (rows.length === 0) break;
    let oldest = after;
    for (const r of rows) {
      if (!isRecord(r)) continue;
      const t = num(r.fundingTime);
      const rate = num(r.realizedRate) || num(r.fundingRate);
      if (t >= from && t < to && Number.isFinite(rate)) out.set(t, rate);
      if (Number.isFinite(t)) oldest = Math.min(oldest, t);
    }
    if (oldest >= after) break;
    after = oldest;
  }
  return out;
}

// ---------- assembling a dataset ----------

export interface Request {
  source: DataSource;
  days: number;
  count: number;
  /** Symbols of the exchange's contracts with the most turnover right now, best first. */
  candidates: string[];
}

/** The start of today in UTC: tests end on a completed day. */
export function testWindow(days: number, now = Date.now()): { from: number; to: number } {
  const to = Math.floor(now / DAY_MS) * DAY_MS;
  return { from: to - days * DAY_MS, to };
}

export async function loadDataset(req: Request, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<Dataset> {
  const { source, days, count } = req;
  const { from, to } = testWindow(days);
  const spec = SOURCES[source];
  const wantOi = spec.oiDays >= days;
  const candidates = req.candidates.slice(0, CANDIDATES);
  if (candidates.length === 0) throw new Error(`${spec.name} 還沒有行情，無法決定合約範圍`);

  // Rank by turnover on the day before the window, so the choice does not peek at the test period.
  const rankDay = from - DAY_MS;
  const ranked: { id: string; turnover: number }[] = [];
  let done = 0;
  await pool(candidates, source === 'binance' ? 3 : 6, async (id) => {
    const turnover = await (source === 'binance' ? binanceDayTurnover : okxDayTurnover)(id, rankDay, signal);
    if (turnover > 0) ranked.push({ id, turnover });
    onProgress({ done: ++done, total: candidates.length, label: '決定合約範圍' });
  });
  ranked.sort((a, b) => b.turnover - a.turnover);
  const ids = ranked.slice(0, count).map((r) => r.id);
  if (ids.length === 0) throw new Error('起始日前一天沒有任何候選合約有成交資料');

  const rows = new Map<string, Row[]>();
  const oiFailed: string[] = [];
  let fundingSeen = false;
  done = 0;
  await pool(ids, source === 'binance' ? 3 : 4, async (id) => {
    const start = from - WARMUP_MS;
    const [bars, funding, oi] = await Promise.all([
      (source === 'binance' ? binanceRows : okxRows)(id, start, to, signal),
      (source === 'binance' ? binanceFunding : okxFunding)(id, from, to, signal),
      wantOi
        ? binanceOi(id, start, to, signal).catch((err) => {
            // Candles alone still make a usable test; record the gap rather than abandon the download.
            if (signal.aborted) throw err;
            oiFailed.push(id);
            return new Map<number, number>();
          })
        : Promise.resolve(new Map<number, number>()),
    ]);
    for (const b of bars) {
      const f = funding.get(b.t);
      if (f !== undefined) {
        b.funding = f;
        fundingSeen = true;
      }
      // Open interest at the bar's close is the snapshot stamped one bar later.
      const o = oi.get(b.t + BAR_MS);
      if (o !== undefined) b.oi = o;
    }
    rows.set(id, bars);
    onProgress({ done: ++done, total: ids.length, label: '下載 K 線' });
  });

  return {
    source,
    from,
    to,
    rows,
    has: { taker: spec.taker, oi: wantOi, funding: fundingSeen },
    universeNote: `${new Date(rankDay).toISOString().slice(0, 10)} 當日成交額前 ${ids.length} 名（從目前成交額前 ${candidates.length} 名中選）`,
    warnings: oiFailed.length ? [`${oiFailed.length} 檔合約的 OI 歷史抓取失敗，這些合約不會觸發需要 OI 的訊號：${oiFailed.join('、')}`] : [],
  };
}
