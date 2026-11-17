import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { SignalState } from '../../backtest/engine';
import type { Horizon } from '../types';
import type { CandleSource } from '../lib/candles';
import { linkOf, type ExchangeData } from '../lib/useExchange';
import { BAR_MS } from '../lib/metrics';
import { fmtClock, fmtHourMinute, fmtPrice, fmtRatio, fmtSpread, fmtTaker, spreadPct } from '../lib/format';
import { stateName } from '../lib/breakout';
import {
  breakoutAtBar,
  DEFAULT_SCREEN,
  describe,
  dirOf,
  loadScreen,
  runScreen,
  saveScreen,
  SIGNAL_STATES,
  type Conditions,
  type Match,
  type Screen,
  type SideChoice,
} from '../lib/screen';
import { NumberField, pct } from './Fields';
import { TrackerPanel } from './TrackerPanel';

const KlineChart = lazy(() => import('./KlineChart'));

interface Props {
  exchanges: ExchangeData[];
  now: number;
  listings: Record<CandleSource, ReadonlySet<string>>;
}

const HORIZONS: Horizon[] = ['1h', '4h', '24h'];
const STATE_OPTION: Record<SignalState, string> = { fresh: '剛突破／剛跌破', holding: '突破後整理', extended: '已延伸', near: '接近突破／跌破' };

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** "3 分前", "2 小時前": time since the bar that confirmed a breakout closed. */
function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小時 ${minutes % 60} 分前`;
}

const fmtAtr = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)} ATR` : '—');

function StateCell({ m, now }: { m: Match; now: number }) {
  const dir = dirOf(m.side);
  const b = m.breakout;
  const live = m.live;
  if (!b) return <span className="muted">—</span>;
  return (
    <span className="state">
      <span>
        <span className={`delta-mark is-${m.side === 'long' ? 'gain' : 'loss'}`} aria-hidden="true">
          {m.side === 'long' ? '▲' : '▼'}
        </span>
        {stateName(b.state, dir)}
        {b.triggerTime !== null && <span className="muted"> · {ago(now - (b.triggerTime + BAR_MS))}</span>}
      </span>
      {live?.crossing && <span className="muted">盤中已越過，待收盤確認</span>}
      {live?.slipping && <span className="warn">盤中{dir === 'up' ? '跌回' : '漲回'}區間</span>}
    </span>
  );
}

export default function ScreenerPage({ exchanges, now, listings }: Props) {
  const [screen, setScreen] = useState<Screen>(loadScreen);
  const [selected, setSelected] = useState<{ exchange: string; symbol: string; side: string } | null>(null);
  useEffect(() => saveScreen(screen), [screen]);

  const c = screen.conditions;
  const set = (patch: Partial<Conditions>) => setScreen((s) => ({ ...s, conditions: { ...s.conditions, ...patch } }));
  const anyCondition = c.useRet || c.useRvol || c.useTaker || c.useOi || c.useRs || c.useBreakout;

  // Breakouts depend on candles and settings, not on the clock: recompute only when those change.
  const [binance, okx] = exchanges;
  const breakoutsA = useMemo(
    () => breakoutAtBar(binance.top, binance.metrics, binance.bars, c),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [binance.top, binance.metrics, binance.bars, c.rangeBars, c.extendAtr],
  );
  const breakoutsB = useMemo(
    () => breakoutAtBar(okx.top, okx.metrics, okx.bars, c),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [okx.top, okx.metrics, okx.bars, c.rangeBars, c.extendAtr],
  );
  const breakouts = [breakoutsA, breakoutsB];

  const results = exchanges.map((ex, i) => ({
    ex,
    link: linkOf(ex, now),
    result: runScreen(screen, ex.top, ex.metrics, breakouts[i]),
  }));
  const matches = results.flatMap(({ ex, link, result }) =>
    result.matches.map((m) => ({ ...m, ex, stale: link === 'down' || link === 'stale' })),
  );
  // Freshest breakouts first, then by relative volume.
  const order = { fresh: 0, near: 1, holding: 2, extended: 3, failed: 4, none: 5, unknown: 6 } as const;
  matches.sort(
    (a, b) =>
      order[a.breakout?.state ?? 'unknown'] - order[b.breakout?.state ?? 'unknown'] ||
      (b.features.rvol || 0) - (a.features.rvol || 0),
  );

  const selectedMatch =
    selected &&
    matches.find((m) => m.ex.adapter.id === selected.exchange && m.ticker.symbol === selected.symbol && m.side === selected.side);
  const levelTitle = (m: Match) => (m.side === 'long' ? '突破位' : '跌破位');

  return (
    <div className="screener">
      <section className="panel">
        <header className="panel-head">
          <h2>篩選條件</h2>
          <button type="button" className="link" onClick={() => setScreen(DEFAULT_SCREEN)}>
            回到預設
          </button>
        </header>
        <div className="form-row">
          <label className="field">
            <span>方向</span>
            <select value={screen.side} onChange={(e) => setScreen((s) => ({ ...s, side: e.target.value as SideChoice }))}>
              <option value="both">多空都看</option>
              <option value="long">只看做多</option>
              <option value="short">只看做空</option>
            </select>
          </label>
        </div>
        <div className="conditions-grid">
          <Check label="突破狀態" checked={c.useBreakout} onChange={(v) => set({ useBreakout: v })} />
          <div className="inline-fields">
            <label className={c.useBreakout ? 'field' : 'field is-off'}>
              <span>狀態</span>
              <select value={c.breakoutState} disabled={!c.useBreakout} onChange={(e) => set({ breakoutState: e.target.value as SignalState })}>
                {SIGNAL_STATES.map((st) => (
                  <option key={st} value={st}>
                    {STATE_OPTION[st]}
                  </option>
                ))}
              </select>
            </label>
            <NumberField
              label="區間根數"
              value={c.rangeBars}
              step={1}
              min={5}
              suffix="根"
              onChange={(v) => Number.isInteger(v) && v <= 96 && set({ rangeBars: v })}
            />
            <NumberField label="延伸門檻" value={c.extendAtr} step={0.25} min={0} suffix="ATR" onChange={(v) => set({ extendAtr: v })} />
          </div>

          <Check label="15 分鐘漲跌" checked={c.useRet} onChange={(v) => set({ useRet: v })} />
          <NumberField label="漲跌幅至少" value={c.retMin} step={0.1} min={0} suffix="%" disabled={!c.useRet} onChange={(v) => set({ retMin: v })} />

          <Check label="RVOL" checked={c.useRvol} onChange={(v) => set({ useRvol: v })} />
          <NumberField label="RVOL 至少" value={c.rvolMin} step={0.5} min={0} suffix="×" disabled={!c.useRvol} onChange={(v) => set({ rvolMin: v })} />

          <Check label="買賣比" checked={c.useTaker} onChange={(v) => set({ useTaker: v })} />
          <NumberField label="做多買賣比至少" value={c.takerMin} step={0.05} min={1} suffix="" disabled={!c.useTaker} onChange={(v) => set({ takerMin: v })} />

          <Check label="OI 增加" checked={c.useOi} onChange={(v) => set({ useOi: v })} />
          <NumberField label="OI 15 分鐘至少" value={c.oiMin} step={0.1} min={0} suffix="%" disabled={!c.useOi} onChange={(v) => set({ oiMin: v })} />

          <Check label="對 BTC 強弱" checked={c.useRs} onChange={(v) => set({ useRs: v })} />
          <div className="inline-fields">
            <label className={c.useRs ? 'field' : 'field is-off'}>
              <span>週期</span>
              <select value={c.rsHorizon} disabled={!c.useRs} onChange={(e) => set({ rsHorizon: e.target.value as Horizon })}>
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="超額至少" value={c.rsMin} step={0.5} min={0} suffix="點" disabled={!c.useRs} onChange={(v) => set({ rsMin: v })} />
          </div>
        </div>
        {anyCondition ? (
          <ul className="conditions">
            {describe(screen).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="alert is-warn">至少要開啟一個條件。</p>
        )}
        <details className="meta">
          <summary>突破狀態怎麼判斷</summary>
          <ul>
            <li>區間：前 {c.rangeBars} 根已收盤 15 分鐘 K 棒的最高價（做空看最低價）。ATR 是最近 14 根的平均真實波幅。</li>
            <li>收盤價超出區間就是突破。突破位與當時的 ATR 會固定下來，之後的距離都相對這個位置計算。</li>
            <li>剛突破：突破的那根與下一根 K 棒，且收盤離突破位不超過 {c.extendAtr} ATR。</li>
            <li>突破後整理：比那更晚，但收盤仍在突破位之外、距離不超過 {c.extendAtr} ATR（包含回踩突破位）。</li>
            <li>已延伸：收盤離突破位超過 {c.extendAtr} ATR，不論是第幾根。</li>
            <li>收盤回到突破位以內就是「跌回區間」，這次突破結束。突破 {c.rangeBars} 根之後，區間已經全部換成新的 K 棒，可以再次觸發。</li>
            <li>接近突破：還沒突破，收盤離區間高點 0.5 ATR 以內。</li>
            <li>狀態只看收盤，跟追蹤、回測一致。即時價只用來算「距突破位」，以及提示「盤中已越過」或「盤中跌回」，不改變狀態。</li>
            <li>做空時，漲跌與強弱改看下跌與落後，買賣比改看門檻的倒數；OI 條件多空都要求增加。</li>
          </ul>
        </details>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>目前符合的合約</h2>
        </header>
        {results.map(({ ex, link, result }) => (
          <p key={ex.adapter.id} className={link === 'down' ? 'alert' : link === 'stale' ? 'alert is-warn' : 'meta'} role={link === 'down' ? 'alert' : undefined}>
            <strong>{ex.adapter.name}</strong>
            {link === 'down' && (ex.lastOk === null ? '：連不上，沒有資料。' : `：連線中斷，資料停在 ${fmtClock(ex.lastOk)}。`)}
            {link === 'stale' && `：資料延遲，最後更新 ${ex.lastOk !== null ? fmtClock(ex.lastOk) : '—'}。`}
            {ex.top.length > 0 && (
              <>
                {link === 'live' || link === 'connecting' ? '：' : ' '}
                {ex.barTime !== null && `依 ${fmtHourMinute(ex.barTime)}–${fmtHourMinute(ex.barTime + BAR_MS)} 的 K 棒，`}
                前 {ex.top.length} 名中可判斷 {result.judged} 檔
                {result.pending > 0 && `，${result.pending} 檔計算中`}
                {result.missing > 0 && `，${result.missing} 檔缺資料無法判斷`}
                ，符合 {result.matches.length} 筆。
              </>
            )}
          </p>
        ))}

        {anyCondition && matches.length === 0 && <p className="empty">目前沒有合約同時符合這些條件。</p>}
        {matches.length > 0 && (
          <div className="rank">
            <div className="rank-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="sticky">
                      合約
                    </th>
                    <th scope="col">狀態</th>
                    <th scope="col" className="num" title="即時價離突破位（跌破位）幾個 ATR，正數代表在突破方向">
                      距突破位
                    </th>
                    <th scope="col" className="num">
                      RVOL
                    </th>
                    <th scope="col" className="num">
                      對 BTC {c.rsHorizon}
                    </th>
                    <th scope="col" className="num" title="買一賣一價差占中間價的比例">
                      價差
                    </th>
                    <th scope="col" className="num">
                      突破位
                    </th>
                    <th scope="col" className="num">
                      價格
                    </th>
                    <th scope="col" className="num">
                      15m
                    </th>
                    <th scope="col" className="num">
                      OI
                    </th>
                    <th scope="col" className="num">
                      買賣比
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => {
                    const key = { exchange: m.ex.adapter.id, symbol: m.ticker.symbol, side: m.side };
                    const active =
                      selected?.exchange === key.exchange && selected.symbol === key.symbol && selected.side === key.side;
                    const f = m.features;
                    return (
                      <tr
                        key={`${key.exchange}-${key.symbol}-${m.side}`}
                        className={[active ? 'is-active' : '', m.stale ? 'is-dim' : ''].join(' ').trim() || undefined}
                        onClick={() => setSelected(active ? null : key)}
                      >
                        <th scope="row" className="sticky">
                          {m.ticker.base}
                          <span className="muted"> {m.ex.adapter.name}</span>
                        </th>
                        <td>
                          <StateCell m={m} now={now} />
                        </td>
                        <td className="num">{fmtAtr(m.live?.dist)}</td>
                        <td className="num">{Number.isFinite(f.rvol) ? fmtRatio(f.rvol) : '—'}</td>
                        <td className="num">{pct(f.excess[c.rsHorizon], 2)}</td>
                        <td className="num">{fmtSpread(spreadPct(m.ticker.bid, m.ticker.ask))}</td>
                        <td className="num">{m.live && Number.isFinite(m.live.level) ? fmtPrice(m.live.level) : '—'}</td>
                        <td className="num">{fmtPrice(m.ticker.price)}</td>
                        <td className="num">{pct(f.ret15, 2)}</td>
                        <td className="num">{pct(f.oi15, 2)}</td>
                        <td className="num">{Number.isFinite(f.taker) ? fmtTaker(f.taker) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {selectedMatch && (
          <Suspense fallback={<p className="kline-foot muted">載入圖表…</p>}>
            <KlineChart
              key={`${selectedMatch.ex.adapter.id}-${selectedMatch.ticker.symbol}-${selectedMatch.side}`}
              base={selectedMatch.ticker.base}
              listed={listings}
              initialSource={selectedMatch.ex.adapter.id as CandleSource}
              levelsSource={selectedMatch.ex.adapter.id as CandleSource}
              levels={
                selectedMatch.live && Number.isFinite(selectedMatch.live.level)
                  ? [{ price: selectedMatch.live.level, title: levelTitle(selectedMatch) }]
                  : []
              }
              onClose={() => setSelected(null)}
            />
          </Suspense>
        )}

        <p className="meta">
          這裡只列出「現在」符合條件的合約，不代表這組條件有效。條件是否真的有用，要看下方的追蹤結果，或到回測頁面驗證。
        </p>
      </section>

      <TrackerPanel screen={screen} />
    </div>
  );
}
