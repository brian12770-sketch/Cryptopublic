import { useEffect, useMemo, useRef, useState } from 'react';
import {
  computeFeatures,
  findTrades,
  REGISTERED,
  summarise,
  unconditional,
  type Params,
  type Side,
} from '../../backtest/engine';
import { DAY_MS, loadDataset, SOURCES, type Dataset, type DataSource, type Progress } from '../lib/backtestData';
import type { ExchangeData } from '../lib/useExchange';
import { FetchError } from '../lib/http';
import { NumberField, share, Stats, VerdictLine } from './Fields';

interface Props {
  exchanges: ExchangeData[];
}

const DAY_CHOICES = [30, 90, 180];
const COUNT_CHOICES = [5, 10, 20, 30];
const HOLD_CHOICES = [
  { bars: 1, label: '15 分鐘' },
  { bars: 2, label: '30 分鐘' },
  { bars: 4, label: '1 小時' },
  { bars: 8, label: '2 小時' },
  { bars: 16, label: '4 小時' },
];
/** The first 70% of the period is for trying parameters; the rest is held back. */
const IN_SAMPLE_SHARE = 0.7;
/** After this many peeks at the held-back period, its result is no longer much of a test. */
const REVEAL_WARNING = 3;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function revealKey(d: Dataset): string {
  return `oosReveals:${d.source}:${d.from}:${d.to}:${d.rows.size}`;
}

function readCount(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

export default function BacktestPage({ exchanges }: Props) {
  const [source, setSource] = useState<DataSource>('binance');
  const [days, setDays] = useState(90);
  const [count, setCount] = useState(10);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<Params>(REGISTERED.base);
  // The parameter set whose held-back result is on screen, if any.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [reveals, setReveals] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const spec = SOURCES[source];
  const effectiveDays = Math.min(days, spec.maxDays);
  const candidates = exchanges.find((e) => e.adapter.id === source)?.ranked ?? [];

  useEffect(() => () => abort.current?.abort(), []);

  const load = async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    setDataset(null);
    setRevealed(null);
    setProgress({ done: 0, total: 1, label: '準備中' });
    try {
      const d = await loadDataset({ source, days: effectiveDays, count, candidates }, ctrl.signal, setProgress);
      setDataset(d);
      setReveals(readCount(revealKey(d)));
      // Filters the data cannot support are switched off rather than silently matching nothing.
      setParams((p) => ({ ...p, useTaker: p.useTaker && d.has.taker, useOi: p.useOi && d.has.oi }));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof FetchError || err instanceof Error ? err.message : '未知錯誤');
    } finally {
      if (abort.current === ctrl) setProgress(null);
    }
  };

  const features = useMemo(
    () => (dataset ? new Map([...dataset.rows].map(([id, rows]) => [id, computeFeatures(rows)])) : null),
    [dataset],
  );

  const split = dataset ? dataset.from + Math.round(((dataset.to - dataset.from) / DAY_MS) * IN_SAMPLE_SHARE) * DAY_MS : 0;

  const quality = useMemo(() => {
    if (!dataset) return null;
    let bars = 0;
    let gaps = 0;
    for (const rows of dataset.rows.values()) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].t < dataset.from) continue;
        bars++;
        if (i > 0 && rows[i].t - rows[i - 1].t !== 15 * 60 * 1000) gaps++;
      }
    }
    const expected = dataset.rows.size * ((dataset.to - dataset.from) / (15 * 60 * 1000));
    return { bars, gaps, coverage: bars / expected };
  }, [dataset]);

  // The benchmark depends only on the holding period, so it is not recomputed on every keystroke.
  const baseline = useMemo(() => {
    if (!dataset) return null;
    const all = [...dataset.rows.values()];
    return {
      inSample: unconditional(all, params.hold, dataset.from, split).mean,
      held: unconditional(all, params.hold, split, dataset.to).mean,
    };
  }, [dataset, params.hold, split]);

  const results = useMemo(() => {
    if (!dataset || !features) return null;
    return (['long', 'short'] as Side[]).map((side) => {
      const trades = [...dataset.rows].flatMap(([id, rows]) =>
        findTrades(id, rows, features.get(id)!, params, side, dataset.from, dataset.to),
      );
      return {
        side,
        inSample: summarise(trades.filter((t) => t.signalTime < split), params.hold, dataset.from, split),
        held: summarise(trades.filter((t) => t.signalTime >= split), params.hold, split, dataset.to),
      };
    });
  }, [dataset, features, params, split]);

  const paramKey = JSON.stringify(params);
  const showHeld = revealed === paramKey;

  const reveal = () => {
    if (!dataset) return;
    const next = reveals + 1;
    setReveals(next);
    setRevealed(paramKey);
    try {
      localStorage.setItem(revealKey(dataset), String(next));
    } catch {
      /* private mode: the count lasts for this visit only */
    }
  };

  const set = (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch }));

  return (
    <div className="backtest">
      <section className="panel">
        <header className="panel-head">
          <h2>1. 下載資料</h2>
        </header>
        <div className="form-row">
          <label className="field">
            <span>資料來源</span>
            <select value={source} onChange={(e) => setSource(e.target.value as DataSource)}>
              <option value="binance">幣安</option>
              <option value="okx">OKX</option>
            </select>
          </label>
          <label className="field">
            <span>期間</span>
            <select value={effectiveDays} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_CHOICES.filter((d) => d <= spec.maxDays).map((d) => (
                <option key={d} value={d}>
                  最近 {d} 天
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>合約數</span>
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {COUNT_CHOICES.map((n) => (
                <option key={n} value={n}>
                  前 {n} 名
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={load} disabled={progress !== null || candidates.length === 0}>
            {progress ? '下載中…' : dataset ? '重新下載' : '下載'}
          </button>
        </div>
        <p className="meta">
          {spec.name}：{spec.note}
          {source === 'binance' && effectiveDays > spec.oiDays && ' 選 30 天才能使用 OI 條件。'}
          {' '}合約以期間開始前一天的成交額排名，避免用現在的熱門幣回頭測。
        </p>
        {candidates.length === 0 && (
          <p className="alert is-warn" role="status">
            {spec.name}目前沒有行情（連線中或連不上），無法決定合約範圍。可以改用另一個資料來源。
          </p>
        )}
        {progress && (
          <p className="meta" role="status">
            {progress.label} {progress.done}/{progress.total}
            <progress value={progress.done} max={progress.total} />
          </p>
        )}
        {error && (
          <p className="alert" role="alert">
            <strong>下載失敗，沒有資料可以回測。</strong> {error}
          </p>
        )}
        {dataset && quality && (
          <>
            <p className="meta">
              已載入 {SOURCES[dataset.source].name} {ymd(dataset.from)} 至 {ymd(dataset.to - 1)}（UTC），
              {dataset.rows.size} 檔合約：{dataset.universeNote}。K 棒 {quality.bars.toLocaleString()} 根，
              為理論上限的 {share(quality.coverage)}，時間不連續 {quality.gaps} 處。
              {dataset.has.funding ? '已含資金費率。' : '沒有取得資金費率，淨報酬只扣手續費。'}
            </p>
            <p className="meta">
              合約：
              {[...dataset.rows.keys()]
                .map((id) => id.replace(/-USDT-SWAP$|USDT$/, ''))
                .join('、')}
            </p>
            {dataset.warnings.map((w) => (
              <p key={w} className="alert is-warn" role="status">
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      {dataset && results && baseline && (
        <>
          <section className="panel">
            <header className="panel-head">
              <h2>2. 設定訊號</h2>
              <button type="button" className="link" onClick={() => setParams({ ...REGISTERED.base })}>
                回到登記的參數
              </button>
            </header>
            <div className="form-row">
              <NumberField label="15 分鐘漲跌至少" value={params.retMin} step={0.1} min={0} suffix="%" onChange={(v) => set({ retMin: v })} />
              <NumberField label="RVOL 至少" value={params.rvolMin} step={0.5} min={0} suffix="×" onChange={(v) => set({ rvolMin: v })} />
              <label className="field">
                <span>持有時間</span>
                <select value={params.hold} onChange={(e) => set({ hold: Number(e.target.value) })}>
                  {HOLD_CHOICES.map((h) => (
                    <option key={h.bars} value={h.bars}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField label="來回手續費" value={params.feePct} step={0.01} min={0} suffix="%" onChange={(v) => set({ feePct: v })} />
            </div>
            <div className="form-row">
              <label className={dataset.has.taker ? 'check' : 'check is-off'}>
                <input type="checkbox" checked={params.useTaker} disabled={!dataset.has.taker} onChange={(e) => set({ useTaker: e.target.checked })} />
                買賣比確認
              </label>
              <NumberField label="做多買賣比至少" value={params.takerMin} step={0.05} min={1} suffix="" disabled={!params.useTaker} onChange={(v) => set({ takerMin: v })} />
              <label className={dataset.has.oi ? 'check' : 'check is-off'}>
                <input type="checkbox" checked={params.useOi} disabled={!dataset.has.oi} onChange={(e) => set({ useOi: e.target.checked })} />
                OI 增加確認
              </label>
              <NumberField label="OI 15 分鐘變化至少" value={params.oiMin} step={0.1} min={0} suffix="%" disabled={!params.useOi} onChange={(v) => set({ oiMin: v })} />
            </div>
            <p className="meta">
              做多：漲幅與買賣比達到門檻；做空：跌幅達到門檻、買賣比低於門檻的倒數
              {params.useTaker && `（${(1 / params.takerMin).toFixed(2)}）`}。OI 條件多空都要求增加。
              {!dataset.has.taker && ' 這份資料沒有主動買賣量，無法使用買賣比條件。'}
              {!dataset.has.oi && ' 這份資料沒有 OI 歷史，無法使用 OI 條件。'}
            </p>
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>3. 結果</h2>
            </header>
            <p className="meta">
              進場在訊號 K 棒的下一根開盤，持有 {HOLD_CHOICES.find((h) => h.bars === params.hold)?.label} 後出場；
              同一合約持倉中不重複進場；不計滑價。信賴區間以進場日為單位重抽樣。
            </p>
            <div className="result-grid">
              {results.map(({ side, inSample, held }) => {
                const sign = side === 'long' ? 1 : -1;
                return (
                  <div key={side} className="result">
                    <h3>{side === 'long' ? '做多' : '做空'}</h3>

                    <h4>
                      樣本內 <span className="muted">{ymd(dataset.from)} 至 {ymd(split - 1)}</span>
                    </h4>
                    <Stats s={inSample} excess={inSample.grossMean - sign * baseline.inSample} />
                    {inSample.n < 30 && <p className="tag">少於 30 筆，無統計意義</p>}

                    <h4>
                      樣本外 <span className="muted">{ymd(split)} 至 {ymd(dataset.to - 1)}</span>
                    </h4>
                    {showHeld ? (
                      <>
                        <Stats s={held} excess={held.grossMean - sign * baseline.held} />
<VerdictLine verdict={held.verdict} />
                      </>
                    ) : (
                      <p className="muted">尚未揭曉。先在樣本內把參數定下來。</p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="reveal">
              {!showHeld && (
                <button type="button" className="primary" onClick={reveal}>
                  用這組參數揭曉樣本外
                </button>
              )}
              <p className={reveals >= REVEAL_WARNING ? 'alert is-warn' : 'meta'}>
                這份資料的樣本外已經揭曉過 {reveals} 次。
                {reveals >= REVEAL_WARNING
                  ? '看過結果再改參數、再揭曉，等於把樣本外也拿來調參，之後的「有效」很可能只是碰巧。要重新驗證請換一段沒看過的期間。'
                  : '改任何參數都會把樣本外重新蓋起來。每揭曉一次，它作為獨立驗證的價值就少一點。'}
              </p>
            </div>

            <p className="meta">
              判定規則與事前登記的回測相同：筆數至少 30、平均淨報酬為正、信賴區間下界大於零，而且該期間的前半與後半都為正，才算「有效」。
              樣本內的數字是用來挑參數的，本身不是證據。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
