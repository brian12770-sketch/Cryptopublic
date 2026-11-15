import { useEffect, useState } from 'react';
import type { Mode, UpColor } from './types';
import { ADAPTERS } from './exchanges';
import { useExchange } from './lib/useExchange';
import { useTrending } from './lib/trending';
import { ExchangePanel } from './components/ExchangePanel';
import { Trending } from './components/Trending';

type Tab = 'binance' | 'okx' | 'pionex' | 'trending';

const TABS: { id: Tab; label: string }[] = [
  { id: 'binance', label: '幣安' },
  { id: 'okx', label: 'OKX' },
  { id: 'pionex', label: 'Pionex' },
  { id: 'trending', label: '熱搜' },
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
  const [mode, setMode] = useState<Mode>(() => stored('mode', ['heat', 'change'] as const, 'heat'));
  const [upColor, setUpColor] = useState<UpColor>(() => stored('upColor', ['green', 'red'] as const, 'green'));
  const [tab, setTab] = useState<Tab>(() => stored('tab', ['binance', 'okx', 'pionex', 'trending'] as const, 'binance'));
  const wide = useWide();
  const now = useNow(1000);

  useEffect(() => {
    document.documentElement.dataset.up = upColor;
    remember('upColor', upColor);
  }, [upColor]);
  useEffect(() => remember('mode', mode), [mode]);
  useEffect(() => remember('tab', tab), [tab]);

  // The hooks run for every exchange; off-screen ones poll slowly to save data.
  const binance = useExchange(ADAPTERS[0], wide || tab === 'binance');
  const okx = useExchange(ADAPTERS[1], wide || tab === 'okx');
  const pionex = useExchange(ADAPTERS[2], wide || tab === 'pionex');
  const exchanges = [binance, okx, pionex];
  const trending = useTrending();

  return (
    <div className="app">
      <header className="top">
        <h1>永續合約熱度</h1>
        <div className="controls">
          <div className="seg" role="group" aria-label="熱力圖顏色代表">
            <button type="button" aria-pressed={mode === 'heat'} onClick={() => setMode('heat')}>
              量能異常
            </button>
            <button type="button" aria-pressed={mode === 'change'} onClick={() => setMode('change')}>
              漲跌幅
            </button>
          </div>
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

      {!wide && (
        <nav className="tabs" aria-label="區塊">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}

      <main className={wide ? 'grid is-wide' : 'grid'}>
        {exchanges.map(
          (ex) => (wide || tab === ex.adapter.id) && <ExchangePanel key={ex.adapter.id} data={ex} mode={mode} now={now} />,
        )}
        {(wide || tab === 'trending') && <Trending trending={trending} exchanges={exchanges} now={now} />}
      </main>

      <footer className="foot">
        行情每 5 秒向交易所重抓一次，不是逐筆即時；下單前請以交易所畫面為準。本頁只讀公開行情，不連任何帳戶。
      </footer>
    </div>
  );
}
