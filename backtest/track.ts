// Daily job: follows every tracker in trackers/ on the archived OKX data that
// arrived after the tracker was committed, and writes the trades to a JSON
// file the website reads.
//
//   node <bundle> --trackers trackers --archive <okx archive dir> --out <results.json>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attachExcess, computeFeatures, DAY_MS, findTrades, universeByTime, type Params } from './engine';
import { loadArchive } from './load';
import { BAR_MS, TOP_N } from '../src/lib/metrics';
import { sidesOf } from '../src/lib/screen';
import { parseTrackerDef, type TrackedTrade, type TrackerResult, type TrackingResults } from '../src/lib/tracker';

const BENCHMARK = 'BTC-USDT-SWAP';
/** Bars needed before a signal can be judged: 3 days of RVOL baseline plus a day of look-back and ranking. */
const WARMUP_MS = 4 * DAY_MS;

const args = process.argv.slice(2);
const value = (name: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing --${name}`);
  return args[i + 1];
};

/** Commit time of the last change to `file`; null when it has never been committed. */
function committedAt(file: string): number | null {
  const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], { encoding: 'utf8' }).trim();
  return out ? Number(out) * 1000 : null;
}

const trackersDir = value('trackers');
const archiveDir = value('archive');
const outFile = value('out');

const files = existsSync(trackersDir) ? readdirSync(trackersDir).filter((f) => f.endsWith('.json')).sort() : [];
const pending: { file: string; result: TrackerResult; registeredAt: number }[] = [];
const results: TrackerResult[] = [];

for (const file of files) {
  const path = join(trackersDir, file);
  const result: TrackerResult = { file, trades: [] };
  results.push(result);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    result.error = '檔案不是有效的 JSON';
    continue;
  }
  const def = parseTrackerDef(raw);
  if (typeof def === 'string') {
    result.error = def;
    continue;
  }
  result.def = def;
  const registeredAt = committedAt(path);
  if (registeredAt === null) {
    result.error = '檔案還沒有提交到 repo，無法確定開始追蹤的時間';
    continue;
  }
  result.registeredAt = registeredAt;
  pending.push({ file, result, registeredAt });
}

// Load only what the oldest tracker needs, plus warm-up for its first signals.
const earliest = Math.min(...pending.map((p) => p.registeredAt));
const fromDay = Number.isFinite(earliest) ? new Date(earliest - WARMUP_MS).toISOString().slice(0, 10) : '9999';
const rows = pending.length ? loadArchive(archiveDir, fromDay) : new Map();
const features = new Map([...rows].map(([id, r]) => [id, computeFeatures(r)]));
const hasBenchmark = attachExcess(features, rows, BENCHMARK);
const universe = universeByTime(features, rows, TOP_N);

let dataFrom: number | null = null;
let dataTo: number | null = null;
for (const list of rows.values()) {
  if (list.length === 0) continue;
  dataFrom = Math.min(dataFrom ?? Infinity, list[0].t);
  dataTo = Math.max(dataTo ?? -Infinity, list[list.length - 1].t);
}

for (const { result, registeredAt } of pending) {
  const def = result.def!;
  // Only bars that opened after the commit: a bar already under way was partly known.
  const from = Math.ceil(registeredAt / BAR_MS) * BAR_MS;
  const to = dataTo === null ? from : dataTo + BAR_MS;
  result.from = from;
  result.to = Math.max(from, to);
  if (def.conditions.useRs && !hasBenchmark) {
    result.error = `存檔裡沒有 ${BENCHMARK}，無法計算對 BTC 的超額`;
    continue;
  }
  const params: Params = { ...def.conditions, hold: def.holdBars, feePct: def.feePct };
  const trades: TrackedTrade[] = [];
  for (const [id, list] of rows) {
    const allow = (t: number) => universe.get(t)?.has(id) ?? false;
    for (const side of sidesOf(def.side)) {
      for (const t of findTrades(id, list, features.get(id)!, params, side, from, to, [def.holdBars], allow)) {
        trades.push({
          instId: id,
          side,
          signalTime: t.signalTime,
          entryTime: t.entryTime,
          gross: Number(t.gross[def.holdBars].toFixed(6)),
          net: Number(t.net[def.holdBars].toFixed(6)),
        });
      }
    }
  }
  trades.sort((a, b) => a.signalTime - b.signalTime || a.instId.localeCompare(b.instId));
  result.trades = trades;
}

const output: TrackingResults = {
  generatedAt: Date.now(),
  source: 'OKX',
  dataFrom,
  dataTo,
  contracts: rows.size,
  universe: `每根 K 棒當下，存檔合約中過去 24 小時成交額前 ${TOP_N} 名`,
  trackers: results,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(output)}\n`);
console.log(
  `Tracked ${pending.length}/${files.length} trackers on ${rows.size} contracts; ` +
    results.map((r) => `${r.file}: ${r.error ?? `${r.trades.length} trades`}`).join('; '),
);
