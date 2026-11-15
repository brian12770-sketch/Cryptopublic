import { lazy, Suspense, useEffect, useState } from 'react';
import type { Horizon, Mode, UpColor } from './types';
import { ADAPTERS } from './exchanges';
import { useExchange } from './lib/useExchange';
import { useTrending } from './lib/trending';
import { ExchangePanel } from './components/ExchangePanel';
import { Trending } from './components/Trending';

// The backtest page is loaded only when it is opened.
const BacktestPage = lazy(() => import('./components/BacktestPage'));

type View = 'board' | 'backtest';

type Tab = 'binance' | 'okx' | 'trending';

const TABS: { id: Tab; label: string }[] = [
  { id: 'binance', label: '幣安' },
  { id: 'okx', label: 'OKX' },
  { id: 'trending', label: '熱搜' },
];

const MODES: { id: Mode; label: string }[] = [
  { id: 'rvol', label: 'RVOL' },
  { id: 'oi', label: 'OI' },
  { id: 'taker', label: '買賣比' },
  { id: 'rs', label: '強弱' },
  { id: 'change', label: '漲跌' },
];

/** At this width all panels sit side by side and the tabs disappear. */
const WIDE = '(min-width: 1180px)';

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice simply does not persist */
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export function App() {
  const [mode, setMode] = useState<Mode>(() => stored('mode', ['rvol', 'oi', 'taker', 'rs', 'change'] as const, 'rvol'));
  const [upColor, setUpColor] = useState<UpColor>(() => stored('upColor', ['green', 'red'] as const, 'green'));
  const [tab, setTab] = useState<Tab>(() => stored('tab', ['binance', 'okx', 'trending'] as const, 'binance'));
  const [horizon, setHorizon] = useState<Horizon>(() => stored('horizon', ['1h', '4h', '24h'] as const, '4h'));
  const [view, setView] = useState<View>('board');
  const board = view === 'board';
  const wide = useWide();
  const now = useNow(1000);

  useEffect(() => {
    document.documentElement.dataset.up = upColor;
    remember('upColor', upColor);
  }, [upColor]);
  useEffect(() => remember('mode', mode), [mode]);
  useEffect(() => remember('tab', tab), [tab]);
  useEffect(() => remember('horizon', horizon), [horizon]);

  // The hooks run for every exchange; off-screen ones poll slowly to save data.
  const binance = useExchange(ADAPTERS[0], board && (wide || tab === 'binance'));
  const okx = useExchange(ADAPTERS[1], board && (wide || tab === 'okx'));
  const exchanges = [binance, okx];
  const listed = { binance: binance.symbols, okx: okx.symbols };
  const trending = useTrending();

  return (
    <div className="app">
      <header className="top">
        <h1>永續合約熱度</h1>
        <div className="controls">
          <div className="seg" role="group" aria-label="頁面">
            <button type="button" aria-pressed={board} onClick={() => setView('board')}>
              看盤
            </button>
            <button type="button" aria-pressed={!board} onClick={() => setView('backtest')}>
              回測
            </button>
          </div>
          {board && (
            <div className="seg" role="group" aria-label="熱力圖顏色代表">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {board && mode === 'rs' && (
            <div className="seg" role="group" aria-label="強弱排名的週期">
              {(['1h', '4h', '24h'] as const).map((h) => (
                <button key={h} type="button" aria-pressed={horizon === h} onClick={() => setHorizon(h)}>
                  {h}
                </button>
              ))}
            </div>
          )}
          <div className="seg" role="group" aria-label="漲跌顏色">
            <button type="button" aria-pressed={upColor === 'green'} onClick={() => setUpColor('green')}>
              綠漲紅跌
            </button>
            <button type="button" aria-pressed={upColor === 'red'} onClick={() => setUpColor('red')}>
              紅漲綠跌
            </button>
          </div>
        </div>
      </header>

      {board && !wide && (
        <nav className="tabs" aria-label="區塊">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}

      {board ? (
      <main className={wide ? 'grid is-wide' : 'grid'}>
        {exchanges.map(
          (ex) => (wide || tab === ex.adapter.id) && <ExchangePanel key={ex.adapter.id} data={ex} mode={mode} now={now} horizon={horizon} onHorizon={setHorizon} listings={listed} />,
        )}
        {(wide || tab === 'trending') && <Trending trending={trending} exchanges={exchanges} now={now} />}
      </main>
      ) : (
        <main>
          <Suspense fallback={<p className="empty">載入回測頁面…</p>}>
            <BacktestPage exchanges={exchanges} />
          </Suspense>
        </main>
      )}

      <footer className="foot">
        價格與成交額每 5 秒向交易所重抓一次，不是逐筆即時；15m、RVOL、OI、買賣比每 15 分鐘隨 K 棒收盤更新。下單前請以交易所畫面為準。本頁只讀公開行情，不連任何帳戶。
      </footer>
    </div>
  );
}
