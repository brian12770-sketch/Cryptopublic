import type { HeatState, Mode, Ticker } from '../types';
import { fmtPct, fmtRatio } from './format';

/** Class boundaries for 24h change, in percent. Seven classes, neutral in the middle. */
export const CHANGE_STEPS = [-6, -3, -1, 1, 3, 6] as const;
export const CHANGE_CLASSES = ['loss3', 'loss2', 'loss1', 'flat', 'gain1', 'gain2', 'gain3'] as const;

/** Class boundaries for the volume-anomaly ratio. Six classes, one hue. */
export const HEAT_STEPS = [1, 1.5, 2, 3, 5] as const;
export const HEAT_CLASSES = ['heat0', 'heat1', 'heat2', 'heat3', 'heat4', 'heat5'] as const;

export const NO_DATA_CLASS = 'nodata';

function bucket(value: number, steps: readonly number[]): number {
  let i = 0;
  while (i < steps.length && value >= steps[i]) i++;
  return i;
}

export function changeClass(pct: number): string {
  return CHANGE_CLASSES[bucket(pct, CHANGE_STEPS)];
}

export function heatClass(ratio: number): string {
  return HEAT_CLASSES[bucket(ratio, HEAT_STEPS)];
}

export function tileClass(mode: Mode, ticker: Ticker, heat: HeatState | undefined): string {
  if (mode === 'change') return changeClass(ticker.changePct);
  return heat?.kind === 'ok' ? heatClass(heat.heat.ratio) : NO_DATA_CLASS;
}

export function tileValue(mode: Mode, ticker: Ticker, heat: HeatState | undefined): string {
  if (mode === 'change') return fmtPct(ticker.changePct);
  return heat?.kind === 'ok' ? fmtRatio(heat.heat.ratio) : '—';
}

export interface LegendStop {
  cls: string;
  label: string;
}

export const CHANGE_LEGEND: LegendStop[] = [
  { cls: 'loss3', label: '≤ −6%' },
  { cls: 'loss2', label: '−3%' },
  { cls: 'loss1', label: '−1%' },
  { cls: 'flat', label: '±1%' },
  { cls: 'gain1', label: '+1%' },
  { cls: 'gain2', label: '+3%' },
  { cls: 'gain3', label: '≥ +6%' },
];

export const HEAT_LEGEND: LegendStop[] = [
  { cls: 'heat0', label: '< 1×' },
  { cls: 'heat1', label: '1×' },
  { cls: 'heat2', label: '1.5×' },
  { cls: 'heat3', label: '2×' },
  { cls: 'heat4', label: '3×' },
  { cls: 'heat5', label: '≥ 5×' },
];
