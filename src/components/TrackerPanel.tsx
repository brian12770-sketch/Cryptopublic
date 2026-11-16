import { useEffect, useMemo, useState } from 'react';
import { summarise } from '../../backtest/engine';
import { describe, sidesOf, type Screen } from '../lib/screen';
import {
  asEngineTrades,
  githubNewFileUrl,
  HOLD_CHOICES,
  REPO,
  TRACKING_URL,
  trackerFileName,
  trackerJson,
  type TrackerDef,
  type TrackerResult,
  type TrackingResults,
} from '../lib/tracker';
import { getJson, FetchError } from '../lib/http';
import { BAR_MS } from '../lib/metrics';
import { NumberField, pct, Stats, VerdictLine } from './Fields';

const when = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const fmtWhen = (ms: number) => when.format(ms);
const holdLabel = (bars: number) => HOLD_CHOICES.find((h) => h.bars === bars)?.label ?? `${bars} 根 K 棒`;
const SIDE_NAME = { long: '做多', short: '做空' } as const;
const RECENT = 6;

type Load = { kind: 'loading' } | { kind: 'none' } | { kind: 'failed'; message: string } | { kind: 'ok'; data: TrackingResults };

function TrackerCard({ result, dataTo }: { result: TrackerResult; dataTo: number | null }) {
  const def = result.def;
  if (!def || result.error) {
    return (
      <article className="tracker">
        <h3>{def?.name ?? result.file}</h3>
        <p className="alert" role="alert">
          <strong>這個追蹤沒有計算。</strong> {result.error}
        </p>
        <p className="meta">檔案：trackers/{result.file}</p>
      </article>
    );
  }
  const from = result.from ?? 0;
  const to = result.to ?? from;
  const started = to > from;
  return (
    <article className="tracker">
      <h3>{def.name}</h3>
      <ul className="conditions">
        {describe({ side: def.side, conditions: def.conditions }).map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>
          持有 {holdLabel(def.holdBars)}，來回手續費 {def.feePct}%
        </li>
      </ul>
      <p className="meta">
        {result.registeredAt !== undefined && `${fmtWhen(result.registeredAt)} 開始追蹤。`}
        {started && dataTo !== null
          ? `已計算到 ${fmtWhen(dataTo + BAR_MS)}。`
          : '存檔資料還沒涵蓋開始之後的時段，明天更新後才會有第一批結果。'}
      </p>
      {started &&
        sidesOf(def.side).map((side) => {
          const trades = result.trades.filter((t) => t.side === side);
          const s = summarise(asEngineTrades(trades, def.holdBars), def.holdBars, from, to);
          const recent = trades.slice(-RECENT).reverse();
          return (
            <section key={side} className="tracker-side">
              <h4>{SIDE_NAME[side]}</h4>
              <Stats s={s} />
              <VerdictLine verdict={s.verdict} />
              {recent.length > 0 && (
                <table className="trades">
                  <caption>最近 {recent.length} 筆</caption>
                  <thead>
                    <tr>
                      <th scope="col">訊號 K 棒</th>
                      <th scope="col">合約</th>
                      <th scope="col" className="num">
                        淨報酬
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((t) => (
                      <tr key={`${t.instId}-${t.signalTime}`}>
                        <td>{fmtWhen(t.signalTime)}</td>
                        <td>{t.instId.replace(/-USDT-SWAP$/, '')}</td>
                        <td className="num">{pct(t.net, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
    </article>
  );
}

function CreateTracker({ screen }: { screen: Screen }) {
  const [name, setName] = useState('');
  const [holdBars, setHoldBars] = useState(4);
  const [feePct, setFeePct] = useState(0.1);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const fileName = useMemo(() => trackerFileName(), []);

  const def: TrackerDef = { name: name.trim() || '未命名', side: screen.side, holdBars, feePct, conditions: screen.conditions };
  const json = trackerJson(def);
  const anyCondition = Object.entries(screen.conditions).some(([k, v]) => k.startsWith('use') && v === true);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="create-tracker">
      <h3>把目前的條件設為追蹤</h3>
      <div className="form-row">
        <label className="field">
          <span>名稱</span>
          <input type="text" value={name} maxLength={60} placeholder="例如：強勢放量做多" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>持有時間</span>
          <select value={holdBars} onChange={(e) => setHoldBars(Number(e.target.value))}>
            {HOLD_CHOICES.map((h) => (
              <option key={h.bars} value={h.bars}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="來回手續費" value={feePct} step={0.01} min={0} suffix="%" onChange={setFeePct} />
      </div>
      {anyCondition ? (
        <>
          <div className="form-row">
            <a className="primary as-link" href={githubNewFileUrl(def, fileName)} target="_blank" rel="noreferrer">
              在 GitHub 建立
            </a>
            <button type="button" className="secondary" onClick={copy}>
              複製設定
            </button>
            {copied === 'ok' && <span className="meta">已複製，可以貼給 Claude 代為建立。</span>}
            {copied === 'failed' && <span className="meta">瀏覽器不允許複製，請從下方手動選取。</span>}
          </div>
          <p className="meta">
            「在 GitHub 建立」會開啟 {REPO} 的新增檔案頁面並填好內容，按下 Commit 就開始追蹤；需要登入 GitHub。
            也可以複製設定貼給 Claude 代為建立。提交之後不要修改檔案：修改會讓追蹤從修改的時間重新開始計算。
          </p>
          <details className="meta">
            <summary>檔案內容（trackers/{fileName}）</summary>
            <pre className="json">{json}</pre>
          </details>
        </>
      ) : (
        <p className="alert is-warn">至少要開啟一個條件才能設為追蹤。</p>
      )}
    </div>
  );
}

export function TrackerPanel({ screen }: { screen: Screen }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    getJson(TRACKING_URL, ctrl.signal)
      .then((data) => {
        const d = data as TrackingResults;
        if (!d || !Array.isArray(d.trackers)) throw new FetchError('shape', '追蹤結果的格式和預期不同');
        setLoad({ kind: 'ok', data: d });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        // 404 means the daily job has not written any results yet, which is not a failure.
        if (err instanceof FetchError && err.status === 404) setLoad({ kind: 'none' });
        else setLoad({ kind: 'failed', message: err instanceof Error ? err.message : '未知錯誤' });
      });
    return () => ctrl.abort();
  }, []);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>追蹤</h2>
      </header>
      <p className="meta">
        追蹤會把一組固定的條件，套用在設定之後才出現的行情上，記下每一次觸發與之後的實際漲跌。
        因為條件在結果出現之前就定好了，它比回測更能說明這組條件是否真的有用。
        每天 09:20（台北時間）用前一天的 OKX 存檔資料更新；範圍是每根 K 棒當下成交額前 50 名的合約，只有 OKX。
      </p>

      {load.kind === 'loading' && <p className="meta">載入追蹤結果…</p>}
      {load.kind === 'none' && <p className="meta">還沒有追蹤結果。</p>}
      {load.kind === 'failed' && (
        <p className="alert" role="alert">
          <strong>追蹤結果載入失敗。</strong> {load.message}
        </p>
      )}
      {load.kind === 'ok' && (
        <>
          <p className="meta">結果產生於 {fmtWhen(load.data.generatedAt)}。</p>
          {load.data.trackers.length === 0 ? (
            <p className="meta">還沒有任何追蹤。用下方的表單把一組條件設為追蹤。</p>
          ) : (
            <div className="tracker-list">
              {load.data.trackers.map((r) => (
                <TrackerCard key={r.file} result={r} dataTo={load.data.dataTo} />
              ))}
            </div>
          )}
        </>
      )}

      <CreateTracker screen={screen} />
    </section>
  );
}
