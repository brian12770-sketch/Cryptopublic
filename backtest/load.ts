// Reads the daily CSV files written by fetch-okx.mjs into one row list per contract.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Row } from './engine';

const num = (s: string) => (s === '' ? NaN : Number(s));

/** Every contract's bars, oldest first. `fromDay` (YYYY-MM-DD) skips older files. */
export function loadArchive(dir: string, fromDay = ''): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.csv.gz') && f.slice(0, 10) >= fromDay).sort()) {
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
