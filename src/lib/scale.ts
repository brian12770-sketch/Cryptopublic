import type { Cell, Metrics, Mode, Ticker } from '../types';
import { fmtPct, fmtRatio, fmtTaker } from './format';

/** Class boundaries for 24h price change, in percent. Seven classes, neutral in the middle. */
export const CHANGE_STEPS = [-6, -3, -1, 1, 3, 6] as const;
export const CHANGE_CLASSES = ['loss3', 'loss2', 'loss1', 'flat', 'gain1', 'gain2', 'gain3'] as const;

/** Class boundaries for relative volume. Six classes, one hue. */
export const RVOL_STEPS = [1, 1.5, 2, 3, 5] as const;
export const RVOL_CLASSES = ['heat0', 'heat1', 'heat2', 'heat3', 'heat4', 'heat5'] as const;

/** Class boundaries for the 15-minute change in open interest, in percent. */
export const OI_STEPS = [-2, -1, -0.3, 0.3, 1, 2] as const;
export const OI_CLASSES = ['oiDn3', 'oiDn2', 'oiDn1', 'flat', 'oiUp1', 'oiUp2', 'oiUp3'] as const;

/**
 * Class boundaries for the taker buy/sell ratio. Symmetric in log terms:
 * 1.5 buys per sell is as far from balance as 1.5 sells per buy (0.67).
 */
export const TAKER_STEPS = [0.67, 0.8, 0.95, 1.05, 1.25, 1.5] as const;
export const TAKER_CLASSES = CHANGE_CLASSES;

export const NO_DATA_CLASS = 'nodata';

function bucket(value: number, steps: readonly number[]): number {
  let i = 0;
  while (i < steps.length && value >= steps[i]) i++;
  return i;
}

export const changeClass = (pct: number): string => CHANGE_CLASSES[bucket(pct, CHANGE_STEPS)];
export const rvolClass = (ratio: number): string => RVOL_CLASSES[bucket(ratio, RVOL_STEPS)];
export const oiClass = (pct: number): string => OI_CLASSES[bucket(pct, OI_STEPS)];
export const takerClass = (ratio: number): string => TAKER_CLASSES[bucket(ratio, TAKER_STEPS)];

/** The cell a heatmap mode reads; undefined for the mode that needs no metrics. */
export function modeCell(mode: Mode, m: Metrics | undefined): Cell | undefined {
  if (mode === 'rvol') return m?.rvol;
  if (mode === 'oi') return m?.oi15;
  if (mode === 'taker') return m?.taker;
  return undefined;
}

export function tileClass(mode: Mode, ticker: Ticker, m: Metrics | undefined): string {
  if (mode === 'change') return changeClass(ticker.changePct);
  const cell = modeCell(mode, m);
  if (cell?.kind !== 'ok') return NO_DATA_CLASS;
  if (mode === 'rvol') return rvolClass(cell.value);
  return mode === 'oi' ? oiClass(cell.value) : takerClass(cell.value);
}

export function tileValue(mode: Mode, ticker: Ticker, m: Metrics | undefined): string {
  if (mode === 'change') return fmtPct(ticker.changePct);
  const cell = modeCell(mode, m);
  if (cell?.kind !== 'ok') return '—';
  if (mode === 'rvol') return fmtRatio(cell.value);
  return mode === 'oi' ? fmtPct(cell.value) : fmtTaker(cell.value);
}

export interface LegendStop {
  cls: string;
  label: string;
}

export const LEGENDS: Record<Mode, { title: string; stops: LegendStop[] }> = {
  rvol: {
    title: '15 分鐘 RVOL',
    stops: [
      { cls: 'heat0', label: '< 1×' },
      { cls: 'heat1', label: '1×' },
      { cls: 'heat2', label: '1.5×' },
      { cls: 'heat3', label: '2×' },
      { cls: 'heat4', label: '3×' },
      { cls: 'heat5', label: '≥ 5×' },
    ],
  },
  oi: {
    title: '15 分鐘 OI 變化',
    stops: [
      { cls: 'oiDn3', label: '≤ −2%' },
      { cls: 'oiDn2', label: '−1%' },
      { cls: 'oiDn1', label: '−0.3%' },
      { cls: 'flat', label: '持平' },
      { cls: 'oiUp1', label: '+0.3%' },
      { cls: 'oiUp2', label: '+1%' },
      { cls: 'oiUp3', label: '≥ +2%' },
    ],
  },
  taker: {
    title: '主動買賣比',
    stops: [
      { cls: 'loss3', label: '≤ 0.67' },
      { cls: 'loss2', label: '0.8' },
      { cls: 'loss1', label: '0.95' },
      { cls: 'flat', label: '均衡' },
      { cls: 'gain1', label: '1.05' },
      { cls: 'gain2', label: '1.25' },
      { cls: 'gain3', label: '≥ 1.5' },
    ],
  },
  change: {
    title: '24 小時漲跌',
    stops: [
      { cls: 'loss3', label: '≤ −6%' },
      { cls: 'loss2', label: '−3%' },
      { cls: 'loss1', label: '−1%' },
      { cls: 'flat', label: '±1%' },
      { cls: 'gain1', label: '+1%' },
      { cls: 'gain2', label: '+3%' },
      { cls: 'gain3', label: '≥ +6%' },
    ],
  },
};
