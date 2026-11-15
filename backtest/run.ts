// Runs the pre-registered tests over daily CSV files written by fetch-okx.mjs
// and prints a Markdown report.
//
//   node <bundle> --data <dir> --from 2026-11-01 --to 2026-11-15 --signals base,full --title "第一段"

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  computeFeatures,
  findTrades,
  HOLDS,
  PRIMARY_HOLD,
  summarise,
  unconditional,
  type Row,
  type Side,
  type SignalName,
  type Trade,
} from './engine';

const args = process.argv.slice(2);
const value = (name: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing --${name}`);
  return args[i + 1];
};
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

const num = (s: string) => (s === '' ? NaN : Number(s));

function load(dir: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.csv.gz')).sort()) {
    const lines = gunzipSync(readFileSync(join(dir, file))).toString('utf8').trim().split('\n');
    const header = lines[0].split(',');
    const col = (name: string) => {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`${file}: no column ${name}`);
      return i;
    };
    const c = {
      instId: col('instId'),
      t: col('t'),
      open: col('open'),
      close: col('close'),
      turnover: col('turnover'),
      oi: col('oi'),
      takerBuy: col('takerBuy'),
      takerSell: col('takerSell'),
      funding: col('funding'),
    };
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      const row: Row = {
        t: Number(f[c.t]),
        open: Number(f[c.open]),
        close: Number(f[c.close]),
        turnover: Number(f[c.turnover]),
        oi: num(f[c.oi]),
        takerBuy: num(f[c.takerBuy]),
        takerSell: num(f[c.takerSell]),
        funding: num(f[c.funding]),
      };
      if (!out.has(f[c.instId])) out.set(f[c.instId], []);
      out.get(f[c.instId])!.push(row);
    }
  }
  for (const rows of out.values()) rows.sort((a, b) => a.t - b.t);
  return out;
}

const pct = (v: number, digits = 3) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
const share = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

const data = load(value('data'));
const from = day(value('from'));
const to = day(value('to'));
const signals = value('signals').split(',') as SignalName[];
const title = value('title');
const all = [...data.values()];
const features = new Map([...data].map(([id, rows]) => [id, computeFeatures(rows)]));

// ---------- data quality ----------

let bars = 0;
let withOi = 0;
let withTaker = 0;
let settlements = 0;
let gaps = 0;
for (const rows of all) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.t < from || r.t >= to) continue;
    bars++;
    if (Number.isFinite(r.oi)) withOi++;
    if (Number.isFinite(r.takerBuy)) withTaker++;
    if (Number.isFinite(r.funding)) settlements++;
    if (i > 0 && r.t - rows[i - 1].t !== 15 * 60 * 1000) gaps++;
  }
}
const expected = all.length * ((to - from) / (15 * 60 * 1000));

console.log(`### ${title}\n`);
console.log(`期間 ${value('from')} 至 ${new Date(to - 1).toISOString().slice(0, 10)}（UTC），${all.length} 檔合約。\n`);
console.log('資料檢查：\n');
console.log(`- K 棒 ${bars} 根，為理論上限 ${expected} 根的 ${share(bars / expected)}；時間不連續 ${gaps} 處。`);
console.log(`- 有 OI 的 K 棒佔 ${share(withOi / bars)}，有主動買賣量的佔 ${share(withTaker / bars)}。`);
console.log(`- 資金費率結算 ${settlements} 筆。\n`);

// ---------- tests ----------

const sides: Side[] = ['long', 'short'];
const label = { base: '基本', full: '完整', long: '做多', short: '做空' } as const;
const base = unconditional(all, PRIMARY_HOLD, from, to);
console.log(`任意時點進場持有 1 小時的平均報酬（做多方向，未扣成本）：${pct(base.mean, 4)}，共 ${base.n} 個進場點。\n`);

const results: { name: SignalName; side: Side; trades: Trade[] }[] = [];
for (const name of signals) {
  for (const side of sides) {
    const trades: Trade[] = [];
    for (const [id, rows] of data) trades.push(...findTrades(id, rows, features.get(id)!, name, side, from, to));
    results.push({ name, side, trades });
  }
}

console.log('主要判定（持有 1 小時，每筆平均淨報酬）：\n');
console.log('| 訊號 | 筆數 | 平均淨報酬 | 95% 信賴區間 | 前半 | 後半 | 判定 |');
console.log('|---|---|---|---|---|---|---|');
for (const { name, side, trades } of results) {
  const s = summarise(trades, PRIMARY_HOLD, from, to);
  console.log(
    `| ${label[name]}・${label[side]} | ${s.n} | ${pct(s.netMean)} | ${pct(s.ci.lo)} 至 ${pct(s.ci.hi)}（${s.ci.clusters} 個進場日） | ${pct(s.firstHalf.netMean)}（${s.firstHalf.n} 筆） | ${pct(s.secondHalf.netMean)}（${s.secondHalf.n} 筆） | **${s.verdict}** |`,
  );
}

console.log('\n輔助數字（持有 1 小時，不作為判定依據）：\n');
console.log('| 訊號 | 平均毛報酬 | 相對任意進場的超額 | 淨報酬中位數 | 勝率 | 筆數最多的合約 |');
console.log('|---|---|---|---|---|---|');
for (const { name, side, trades } of results) {
  const s = summarise(trades, PRIMARY_HOLD, from, to);
  const excess = s.grossMean - (side === 'long' ? base.mean : -base.mean);
  console.log(
    `| ${label[name]}・${label[side]} | ${pct(s.grossMean)} | ${pct(excess)} | ${pct(s.netMedian)} | ${share(s.winRate)} | ${s.topInst.replace('-USDT-SWAP', '')} ${share(s.topShare)} |`,
  );
}

console.log('\n其他持有時間的每筆平均淨報酬（僅供參考）：\n');
console.log('| 訊號 | 15 分鐘 | 1 小時 | 4 小時 |');
console.log('|---|---|---|---|');
for (const { name, side, trades } of results) {
  const cell = (hold: number) => {
    const s = summarise(trades, hold, from, to);
    return `${pct(s.netMean)}（${s.n} 筆）`;
  };
  console.log(`| ${label[name]}・${label[side]} | ${cell(1)} | ${cell(4)} | ${cell(16)} |`);
}
console.log(`\n持有時間：${HOLDS.map((h) => h * 15).sort((a, b) => a - b).join('、')} 分鐘。`);
