// Downloads OKX 15-minute history for USDT perpetuals and writes one gzipped
// CSV per UTC day. Used two ways:
//
//   node backtest/fetch-okx.mjs --from 2026-11-01 --to 2026-11-15 \
//        --universe 50@2026-10-31 --stats --out <dir>      (backtest sample)
//   node backtest/fetch-okx.mjs --archive <dir>            (daily archive)
//
// Columns: instId,t,open,high,low,close,turnover,oi,takerBuy,takerSell,funding
//   t          bar open time, ms since epoch (UTC)
//   turnover   USDT traded in the bar
//   oi         open interest in coins at the bar's close
//   takerBuy / takerSell   taker turnover in USDT within the bar
//   funding    the funding rate settled at this bar's open time, if any
// Empty cells mean the exchange had no value; they are never filled in.
//
// Read-only public endpoints; no account access and no credentials.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const API = 'https://www.okx.com/api/v5';
const BAR_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** OKX keeps 15-minute open interest and taker volume for about this long. */
const STATS_RETENTION_DAYS = 14;

// ---------- arguments ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const day = (s) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Not a date: ${s}`);
  return t;
};
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// ---------- rate-limited fetch ----------

/** One limiter per endpoint family: OKX meters them separately. */
function limiter(perSecond) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}
const limits = { candles: limiter(8), stats: limiter(3), funding: limiter(4), public: limiter(8) };
let requests = 0;

async function get(family, path) {
  for (let attempt = 1; ; attempt++) {
    await limits[family]();
    requests++;
    let body;
    let status = 0;
    try {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } });
      status = res.status;
      body = await res.json();
    } catch (err) {
      body = { code: 'network', msg: String(err) };
    }
    if (status === 200 && body.code === '0' && Array.isArray(body.data)) return body.data;
    // 429 and code 50011 are rate limits; anything else is retried a few times, then fatal.
    const limited = status === 429 || body.code === '50011';
    if (attempt >= (limited ? 8 : 4)) {
      throw new Error(`OKX ${path} failed: HTTP ${status} code ${body.code} ${body.msg ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, (limited ? 2000 : 500) * attempt));
  }
}

async function pool(items, limit, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}

// ---------- series ----------

/** 15-minute candles with open time in [from, to), as Map(t -> row). */
async function candles(instId, from, to) {
  const out = new Map();
  let after = to;
  while (after > from) {
    const rows = await get('candles', `/market/history-candles?instId=${instId}&bar=15m&limit=100&after=${after}`);
    if (rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r[0]);
      // r[8] === '1' marks a closed candle.
      if (t >= from && t < to && r[8] === '1') out.set(t, { o: r[1], h: r[2], l: r[3], c: r[4], turnover: r[7] });
    }
    after = Number(rows[rows.length - 1][0]);
  }
  return out;
}

/** Rows of a statistics series with period start in [from, to), newest first across pages. */
async function stats(path, instId, from, to) {
  const out = [];
  let end = to - 1;
  while (end >= from) {
    const rows = await get('stats', `/rubik/stat/${path}&instId=${instId}&period=15m&limit=100&end=${end}`);
    if (rows.length === 0) break;
    for (const r of rows) if (Number(r[0]) >= from && Number(r[0]) < to) out.push(r);
    const oldest = Number(rows[rows.length - 1][0]);
    if (oldest > end) break; // the API ignored `end`; stop rather than loop
    end = oldest - 1;
  }
  return out;
}

/** Funding settlements with time in [from, to), as Map(fundingTime -> rate). */
async function funding(instId, from, to) {
  const out = new Map();
  let after = to;
  while (after > from) {
    const rows = await get('funding', `/public/funding-rate-history?instId=${instId}&limit=100&after=${after}`);
    if (rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      if (t >= from && t < to) out.set(t, r.realizedRate || r.fundingRate);
    }
    after = Number(rows[rows.length - 1].fundingTime);
  }
  return out;
}

// ---------- universe ----------

async function listedSwaps() {
  const rows = await get('public', '/public/instruments?instType=SWAP');
  return rows.filter((r) => r.instId.endsWith('-USDT-SWAP')).map((r) => r.instId);
}

/** The `n` USDT perpetuals with the highest USDT turnover on the UTC day `date`. */
async function topByDay(n, date) {
  const ids = await listedSwaps();
  const ranked = [];
  await pool(ids, 6, async (instId) => {
    // `after` returns candles that opened before it; the newest of those is the day we want.
    const rows = await get('candles', `/market/history-candles?instId=${instId}&bar=1Dutc&limit=1&after=${date + DAY_MS}`);
    const row = rows[0];
    if (row && Number(row[0]) === date) ranked.push({ instId, turnover: Number(row[7]) });
  });
  ranked.sort((a, b) => b.turnover - a.turnover);
  return ranked.slice(0, n).map((r) => r.instId);
}

/** The `n` USDT perpetuals with the highest 24h turnover right now. */
async function topNow(n) {
  const rows = await get('public', '/market/tickers?instType=SWAP');
  return rows
    .filter((r) => r.instId.endsWith('-USDT-SWAP'))
    .map((r) => ({ instId: r.instId, turnover: Number(r.volCcy24h) * Number(r.last) }))
    .filter((r) => r.turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, n)
    .map((r) => r.instId);
}

// ---------- download and write ----------

const HEADER = 'instId,t,open,high,low,close,turnover,oi,takerBuy,takerSell,funding';

/** Fetch every series for `ids` over [from, to) and return CSV lines grouped by UTC day. */
async function download(ids, from, to, withStats) {
  const byDay = new Map();
  const missing = { candles: [], oi: [], taker: [] };
  let done = 0;
  await pool(ids, 4, async (instId) => {
    const [bars, oiRows, takerRows, fund] = await Promise.all([
      candles(instId, from, to),
      withStats ? stats('contracts/open-interest-history?', instId, from, to) : [],
      withStats ? stats('taker-volume-contract?unit=2', instId, from, to) : [],
      funding(instId, from, to),
    ]);
    // Open-interest rows are stamped with the period start and hold the value at its close.
    const oi = new Map(oiRows.map((r) => [Number(r[0]), r[2]]));
    // Taker rows are [ts, sell, buy].
    const taker = new Map(takerRows.map((r) => [Number(r[0]), { sell: r[1], buy: r[2] }]));
    if (bars.size === 0) missing.candles.push(instId);
    if (withStats && oi.size === 0) missing.oi.push(instId);
    if (withStats && taker.size === 0) missing.taker.push(instId);
    for (const t of [...bars.keys()].sort((a, b) => a - b)) {
      const b = bars.get(t);
      const k = taker.get(t);
      const line = [instId, t, b.o, b.h, b.l, b.c, b.turnover, oi.get(t) ?? '', k?.buy ?? '', k?.sell ?? '', fund.get(t) ?? ''].join(',');
      const key = ymd(t);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(line);
    }
    done++;
    if (done % 5 === 0 || done === ids.length) console.log(`  ${done}/${ids.length} contracts, ${requests} requests`);
  });
  return { byDay, missing };
}

function writeDays(dir, byDay) {
  mkdirSync(dir, { recursive: true });
  for (const [key, lines] of [...byDay].sort()) {
    lines.sort();
    writeFileSync(join(dir, `${key}.csv.gz`), gzipSync(`${HEADER}\n${lines.join('\n')}\n`));
  }
}

function report(missing) {
  // A series that came back empty is a failed lookup, not "no trading": say so.
  for (const [name, ids] of Object.entries(missing)) {
    if (ids.length) console.log(`WARNING: no ${name} rows for ${ids.length} contracts: ${ids.join(' ')}`);
  }
}

async function main() {
  const started = Date.now();
  if (value('archive')) {
    // Archive mode: write each complete UTC day still within OKX's retention that is not on disk yet.
    const dir = value('archive');
    mkdirSync(dir, { recursive: true });
    const have = new Set(readdirSync(dir).filter((f) => f.endsWith('.csv.gz')).map((f) => f.slice(0, 10)));
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const wanted = [];
    for (let d = today - STATS_RETENTION_DAYS * DAY_MS; d < today; d += DAY_MS) if (!have.has(ymd(d))) wanted.push(d);
    if (wanted.length === 0) {
      console.log('Archive is up to date.');
      return;
    }
    const ids = await topNow(Number(value('top') ?? 50));
    const from = wanted[0];
    const to = wanted[wanted.length - 1] + DAY_MS;
    console.log(`Archiving ${ymd(from)}..${ymd(to - DAY_MS)} for ${ids.length} contracts (top by 24h turnover now)`);
    const { byDay, missing } = await download(ids, from, to, true);
    // Only days that were missing are written; days already on disk are never rewritten.
    writeDays(dir, new Map([...byDay].filter(([key]) => !have.has(key))));
    report(missing);
  } else {
    const from = day(value('from'));
    const to = day(value('to'));
    const dir = value('out');
    const [n, date] = (value('universe') ?? '').split('@');
    if (!dir || !n || !date || !(to > from)) throw new Error('Need --from, --to, --universe N@YYYY-MM-DD and --out');
    const ids = await topByDay(Number(n), day(date));
    console.log(`Universe: top ${ids.length} by USDT turnover on ${date}: ${ids.join(' ')}`);
    const { byDay, missing } = await download(ids, from, to, flag('stats'));
    writeDays(dir, byDay);
    writeFileSync(join(dir, 'universe.json'), JSON.stringify({ rankedOn: date, from: ymd(from), to: ymd(to), ids }, null, 1));
    report(missing);
  }
  console.log(`Done: ${requests} requests in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (!existsSync(value('archive') ?? value('out'))) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
