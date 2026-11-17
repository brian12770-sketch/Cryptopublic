// Signal trackers: a set of conditions committed to the repo, then followed on
// data that arrives after the commit. Read by the daily job (backtest/track.ts)
// and by the website, so both sides agree on the format.

import type { Side, Trade } from '../../backtest/engine';
import { parseScreen, type Conditions, type SideChoice } from './screen';

export const REPO = 'brian12770-sketch/Cryptopublic';
/** The repo's default branch: scheduled jobs run from it, so trackers must be committed there. */
export const DEFAULT_BRANCH = 'claude/sleepy-mendel-cga24x';
export const TRACKERS_DIR = 'trackers';
export const TRACKING_URL =
  import.meta.env?.VITE_TRACKING_URL ?? `https://raw.githubusercontent.com/${REPO}/data/tracking/results.json`;

/** Holding periods a tracker may use, in 15-minute bars. */
export const HOLD_CHOICES = [
  { bars: 1, label: '15 分鐘' },
  { bars: 2, label: '30 分鐘' },
  { bars: 4, label: '1 小時' },
  { bars: 8, label: '2 小時' },
  { bars: 16, label: '4 小時' },
];

export interface TrackerDef {
  name: string;
  side: SideChoice;
  holdBars: number;
  feePct: number;
  conditions: Conditions;
}

/** Validate an untrusted tracker file; returns the problem in plain words when it is not valid. */
export function parseTrackerDef(raw: unknown): TrackerDef | string {
  if (typeof raw !== 'object' || raw === null) return '不是 JSON 物件';
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.trim() === '' || r.name.length > 60) return 'name 必須是 1 到 60 字的文字';
  if (!HOLD_CHOICES.some((h) => h.bars === r.holdBars)) return `holdBars 必須是 ${HOLD_CHOICES.map((h) => h.bars).join('、')} 之一`;
  if (typeof r.feePct !== 'number' || !(r.feePct >= 0 && r.feePct <= 1)) return 'feePct 必須介於 0 到 1';
  const screen = parseScreen({ side: r.side, conditions: r.conditions });
  if (!screen) return 'side 或 conditions 的格式不對';
  const c = screen.conditions;
  if (!(c.useRet || c.useRvol || c.useTaker || c.useOi || c.useRs || c.useBreakout)) return '至少要開啟一個條件';
  return { name: r.name.trim(), side: screen.side, holdBars: r.holdBars as number, feePct: r.feePct, conditions: c };
}

/** File name for a new tracker: the creation time keeps names unique and sortable. */
export function trackerFileName(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${stamp}.json`;
}

export function trackerJson(def: TrackerDef): string {
  return `${JSON.stringify(def, null, 2)}\n`;
}

/** GitHub's "create new file" page with the tracker filled in; committing it starts the clock. */
export function githubNewFileUrl(def: TrackerDef, fileName: string): string {
  // encodeURIComponent writes spaces as %20, which every decoder reads the same way ("+" is not).
  const filename = encodeURIComponent(`${TRACKERS_DIR}/${fileName}`);
  const value = encodeURIComponent(trackerJson(def));
  return `https://github.com/${REPO}/new/${DEFAULT_BRANCH}?filename=${filename}&value=${value}`;
}

// ---------- results written by the daily job ----------

export interface TrackedTrade {
  instId: string;
  side: Side;
  signalTime: number;
  entryTime: number;
  /** Signed return before costs over the tracker's holding period, in percent. */
  gross: number;
  /** After fees and funding, in percent. */
  net: number;
}

export interface TrackerResult {
  file: string;
  /** Present when the file could not be used; the tracker then has no trades. */
  error?: string;
  def?: TrackerDef;
  /** Time of the commit that last changed the file: signals count from the next bar on. */
  registeredAt?: number;
  /** Signal bars considered: [from, to). */
  from?: number;
  to?: number;
  trades: TrackedTrade[];
}

export interface TrackingResults {
  generatedAt: number;
  source: string;
  /** Range of archived bars, as bar open times. */
  dataFrom: number | null;
  dataTo: number | null;
  contracts: number;
  universe: string;
  trackers: TrackerResult[];
}

/** The engine's trade shape, keyed by the tracker's holding period. */
export function asEngineTrades(trades: TrackedTrade[], hold: number): Trade[] {
  return trades.map((t) => ({ ...t, gross: { [hold]: t.gross }, net: { [hold]: t.net } }));
}
