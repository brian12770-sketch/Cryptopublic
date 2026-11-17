import { describe, expect, it } from 'vitest';
import { breakoutSeries, liveBreakout, stateName, type BreakoutSettings, type Candle } from '../src/lib/breakout';
import { BAR_MS } from '../src/lib/metrics';

const T0 = 1794700800000;
// Small numbers keep the arithmetic in the tests checkable by hand.
const S: BreakoutSettings = { rangeBars: 4, atrBars: 2, freshBars: 1, extendAtr: 1.5, nearAtr: 0.5 };

/** A flat range: every bar 99–101, closing at 100, so every true range is 2 and ATR is 2. */
function flat(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ t: T0 + i * BAR_MS, high: 101, low: 99, close: 100 }));
}

function push(bars: Candle[], high: number, low: number, close: number) {
  bars.push({ t: bars[bars.length - 1].t + BAR_MS, high, low, close });
}

describe('breakoutSeries', () => {
  it('is unknown until there is a full range and ATR, then near or inside the range', () => {
    const bars = flat(6);
    push(bars, 100.5, 99, 99.5); // 1.5 below 101 with ATR 1.75: inside, not near
    const out = breakoutSeries(bars, S);
    expect(out.slice(0, 4).map((b) => b.up.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    // A close exactly nearAtr from the level counts as near: 1 below 101 with ATR 2.
    expect(out[4].up).toMatchObject({ state: 'near', level: 101, atr: 2, dist: -0.5 });
    expect(out[4].down).toMatchObject({ state: 'near', level: 99, dist: -0.5 });
    expect(out[6].up.state).toBe('none');
    expect(out[6].up.dist).toBeCloseTo(-1.5 / 1.75, 10);
  });

  it('marks a bar near the level, and freezes the level and ATR at the trigger', () => {
    const bars = flat(6);
    push(bars, 101, 100, 100.5); // within 0.5 ATR of 101: near
    push(bars, 102.5, 100.5, 102); // closes above 101: trigger
    push(bars, 103, 101.5, 102.5); // next bar: still fresh (1 bar since, 0.75 ATR)
    push(bars, 105, 102, 104.8); // 2 bars since: extended
    const out = breakoutSeries(bars, S);
    expect(out[6].up.state).toBe('near');
    const trigger = out[7].up;
    // ATR at the trigger: true ranges 1 (bar 6) and 2 (bar 7) -> 1.5.
    expect(trigger).toMatchObject({ state: 'fresh', level: 101, atr: 1.5, triggerTime: bars[7].t, barsSince: 0 });
    expect(trigger.dist).toBeCloseTo(1 / 1.5, 10);
    expect(out[8].up).toMatchObject({ state: 'fresh', level: 101, atr: 1.5, triggerTime: bars[7].t, barsSince: 1 });
    expect(out[9].up).toMatchObject({ state: 'extended', level: 101, barsSince: 2 });
    expect(out[9].up.dist).toBeCloseTo(3.8 / 1.5, 10);
  });

  it('calls a far first close extended, not fresh', () => {
    const bars = flat(6);
    push(bars, 106, 100, 105.5); // 4.5 above 101; ATR (2 + 6) / 2 = 4 -> 1.125 ATR: fresh
    push(bars, 110, 105, 109); // still within the episode, 2 ATR beyond: extended
    const out = breakoutSeries(bars, S);
    expect(out[6].up.state).toBe('fresh');
    expect(out[7].up.state).toBe('extended');
    const big = flat(6);
    push(big, 140, 100, 139); // ATR (2 + 40) / 2 = 21; 38 / 21 = 1.8 ATR: extended at once
    expect(breakoutSeries(big, S)[6].up).toMatchObject({ state: 'extended', barsSince: 0 });
  });

  it('fails when a close comes back inside the level, then can trigger again', () => {
    const bars = flat(6);
    push(bars, 102.5, 100.5, 102); // trigger at 101
    push(bars, 102, 100, 100.5); // closes back below 101: failed
    push(bars, 101, 100, 100.8); // no breakout now; range high is 102.5
    push(bars, 103.5, 100.5, 103); // above 102.5: a new trigger
    const out = breakoutSeries(bars, S);
    expect(out[6].up.state).toBe('fresh');
    expect(out[7].up).toMatchObject({ state: 'failed', level: 101, triggerTime: bars[6].t });
    expect(out[8].up.state).not.toBe('failed');
    expect(out[8].up.triggerTime).toBeNull();
    expect(out[9].up).toMatchObject({ state: 'fresh', level: 102.5, triggerTime: bars[9].t });
  });

  it('ends a breakout once the range has been rebuilt after it, allowing a new trigger', () => {
    const bars = flat(6);
    push(bars, 102.5, 100.5, 102); // trigger at 101 (bar 6)
    for (let k = 0; k < 3; k++) push(bars, 103, 102, 102.5); // bars 7–9: still in the episode
    push(bars, 104, 102.5, 103.8); // bar 10: 4 bars since; range is bars 6–9 (high 103) -> new trigger
    const out = breakoutSeries(bars, S);
    // Close to the level but past the fresh window: holding, not extended.
    expect(out[8].up).toMatchObject({ state: 'holding', barsSince: 2 });
    expect(out[9].up).toMatchObject({ state: 'holding', triggerTime: bars[6].t, barsSince: 3 });
    expect(out[10].up).toMatchObject({ state: 'fresh', level: 103, triggerTime: bars[10].t, barsSince: 0 });
  });

  it('mirrors everything for a break below the range', () => {
    const bars = flat(6);
    push(bars, 99.5, 97.5, 98); // closes below 99
    push(bars, 99.5, 98, 99.2); // back above 99: failed
    const out = breakoutSeries(bars, S);
    expect(out[6].down).toMatchObject({ state: 'fresh', level: 99, triggerTime: bars[6].t });
    expect(out[6].up.state).toBe('none');
    expect(out[7].down).toMatchObject({ state: 'failed', level: 99 });
    expect(stateName('fresh', 'down')).toBe('剛跌破');
    expect(stateName('failed', 'down')).toBe('漲回區間');
    expect(stateName('failed', 'up')).toBe('跌回區間');
  });

  it('treats a gap in the bars as unknown and forgets an active breakout', () => {
    const bars = flat(6);
    push(bars, 102.5, 100.5, 102); // trigger
    bars.push({ t: bars[bars.length - 1].t + 3 * BAR_MS, high: 103, low: 101, close: 102.5 }); // two bars missing
    const out = breakoutSeries(bars, S);
    expect(out[7].up.state).toBe('unknown');
  });
});

describe('liveBreakout', () => {
  it('measures an active breakout against its frozen level and flags a slip back inside', () => {
    const bars = flat(6);
    push(bars, 102.5, 100.5, 102);
    const last = breakoutSeries(bars, S)[6].up; // level 101; ATR (2 + 2.5) / 2 = 2.25
    expect(liveBreakout(bars, last, 'up', 102.125, S)).toMatchObject({ level: 101, crossing: false, slipping: false });
    expect(liveBreakout(bars, last, 'up', 102.125, S).dist).toBeCloseTo(0.5, 10);
    expect(liveBreakout(bars, last, 'up', 100.5, S).slipping).toBe(true);
  });

  it('flags a price beyond the range that no closed bar has confirmed', () => {
    const bars = flat(6);
    const last = breakoutSeries(bars, S)[5].up; // inside, ATR 2
    const live = liveBreakout(bars, last, 'up', 102, S);
    expect(live).toMatchObject({ level: 101, crossing: true });
    expect(live.dist).toBeCloseTo(0.5, 10);
    expect(liveBreakout(bars, last, 'up', 100.5, S).crossing).toBe(false);
  });
});
