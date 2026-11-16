import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { Horizon } from '../types';
import type { CandleSource } from '../lib/candles';
import { linkOf, type ExchangeData } from '../lib/useExchange';
import { BAR_MS } from '../lib/metrics';
import { fmtClock, fmtHourMinute, fmtPrice, fmtRatio, fmtTaker } from '../lib/format';
import { DEFAULT_SCREEN, describe, loadScreen, runScreen, saveScreen, type Conditions, type Screen, type SideChoice } from '../lib/screen';
import { NumberField, pct } from './Fields';
import { TrackerPanel } from './TrackerPanel';

const KlineChart = lazy(() => import('./KlineChart'));

interface Props {
  exchanges: ExchangeData[];
  now: number;
  listings: Record<CandleSource, ReadonlySet<string>>;
}

const HORIZONS: Horizon[] = ['1h', '4h', '24h'];

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function ScreenerPage({ exchanges, now, listings }: Props) {
  const [screen, setScreen] = useState<Screen>(loadScreen);
  const [selected, setSelected] = useState<{ exchange: string; symbol: string } | null>(null);
  useEffect(() => saveScreen(screen), [screen]);

  const c = screen.conditions;
  const set = (patch: Partial<Conditions>) => setScreen((s) => ({ ...s, conditions: { ...s.conditions, ...patch } }));
  const anyCondition = c.useRet || c.useRvol || c.useTaker || c.useOi || c.useRs;

  const results = useMemo(
    () => exchanges.map((ex) => ({ ex, link: linkOf(ex, now), result: runScreen(screen, ex.top, ex.metrics) })),
    [exchanges, screen, now],
  );
  const matches = results.flatMap(({ ex, link, result }) =>
    result.matches.map((m) => ({ ...m, ex, stale: link === 'down' || link === 'stale' })),
  );
  // Strongest relative volume first: it is the condition most matches share.
  matches.sort((a, b) => (b.features.rvol || 0) - (a.features.rvol || 0));

  const selectedMatch = selected && matches.find((m) => m.ex.adapter.id === selected.exchange && m.ticker.symbol === selected.symbol);

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
        <p className="meta">做空時，漲跌與強弱改看下跌與落後，買賣比改看門檻的倒數；OI 條件多空都要求增加。</p>
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
                    <th scope="col">方向</th>
                    <th scope="col" className="num">
                      15m
                    </th>
                    <th scope="col" className="num">
                      RVOL
                    </th>
                    <th scope="col" className="num">
                      OI
                    </th>
                    <th scope="col" className="num">
                      買賣比
                    </th>
                    <th scope="col" className="num">
                      對 BTC {c.rsHorizon}
                    </th>
                    <th scope="col" className="num">
                      價格
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => {
                    const key = { exchange: m.ex.adapter.id, symbol: m.ticker.symbol };
                    const active = selected?.exchange === key.exchange && selected.symbol === key.symbol;
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
                          <span className={`delta-mark is-${m.side === 'long' ? 'gain' : 'loss'}`} aria-hidden="true">
                            {m.side === 'long' ? '▲' : '▼'}
                          </span>
                          {m.side === 'long' ? '做多' : '做空'}
                        </td>
                        <td className="num">{pct(f.ret15, 2)}</td>
                        <td className="num">{Number.isFinite(f.rvol) ? fmtRatio(f.rvol) : '—'}</td>
                        <td className="num">{pct(f.oi15, 2)}</td>
                        <td className="num">{Number.isFinite(f.taker) ? fmtTaker(f.taker) : '—'}</td>
                        <td className="num">{pct(f.excess[c.rsHorizon], 2)}</td>
                        <td className="num">{fmtPrice(m.ticker.price)}</td>
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
              key={`${selectedMatch.ex.adapter.id}-${selectedMatch.ticker.symbol}`}
              base={selectedMatch.ticker.base}
              listed={listings}
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
