import type { ExchangeData } from '../lib/useExchange';
import type { TrendingData } from '../lib/trending';
import { fmtClock, fmtPrice, fmtRatio } from '../lib/format';
import { heatClass } from '../lib/scale';
import { Delta } from './RankTable';

interface Props {
  trending: TrendingData;
  exchanges: ExchangeData[];
  now: number;
}

/** Older than this and the list is shown as stale rather than current. */
const STALE_MS = 20 * 60 * 1000;

/** Exchanges list cheap coins in lots, e.g. 1000PEPE for PEPE. */
function sameCoin(base: string, symbol: string): boolean {
  return base === symbol || base.replace(/^10{3,}/, '') === symbol;
}

function ExchangeHeat({ data, symbol }: { data: ExchangeData; symbol: string }) {
  const name = data.adapter.name;
  // No ticker data at all is a failed lookup, which is not the same thing as
  // "this coin is not in the exchange's top 50".
  if (data.top.length === 0) {
    return (
      <span className="chip is-off">
        {name} {data.error ? '連線失敗' : '連線中'}
      </span>
    );
  }
  const ticker = data.top.find((t) => sameCoin(t.base, symbol));
  if (!ticker) return null;
  const state = data.heat[ticker.symbol];
  if (state?.kind === 'ok') {
    return (
      <span className="chip">
        <span className={`swatch c-${heatClass(state.heat.ratio)}`} aria-hidden="true" />
        {name} {fmtRatio(state.heat.ratio)}
      </span>
    );
  }
  const why = state?.kind === 'failed' ? '抓取失敗' : state?.kind === 'insufficient' ? '資料不足' : '計算中';
  return (
    <span className="chip is-off">
      {name} {why}
    </span>
  );
}

/** Exchanges with data where the coin is outside the top 50. */
function absentFrom(exchanges: ExchangeData[], symbol: string): string[] {
  return exchanges
    .filter((ex) => ex.top.length > 0 && !ex.top.some((t) => sameCoin(t.base, symbol)))
    .map((ex) => ex.adapter.name);
}

export function Trending({ trending, exchanges, now }: Props) {
  const { coins, lastOk, error } = trending;
  const stale = lastOk !== null && now - lastOk > STALE_MS;
  const failedOnly = lastOk === null && error !== null;

  return (
    <section className="panel trending" aria-label="市場熱搜">
      <header className="panel-head">
        <h2>市場熱搜</h2>
        <span className={`status is-${failedOnly ? 'down' : stale ? 'stale' : lastOk === null ? 'connecting' : 'live'}`}>
          {failedOnly ? '✕ 取得失敗' : lastOk === null ? '… 連線中' : stale ? '▲ 延遲' : '● 已更新'}
          {lastOk !== null && <span className="status-time"> · {fmtClock(lastOk)}</span>}
        </span>
      </header>

      <p className="meta">
        來源：CoinGecko 過去 24 小時被搜尋最多的幣，每 5 分鐘重抓。這是搜尋熱度，不是 X 或幣安廣場的貼文統計。
        右側是該幣在三間交易所永續合約的量能倍數。
      </p>

      {(failedOnly || (stale && error)) && (
        <p className={failedOnly ? 'alert' : 'alert is-warn'} role="alert">
          <strong>{failedOnly ? '熱搜資料取得失敗。' : `熱搜資料停在 ${fmtClock(lastOk ?? 0)}。`}</strong> {error}
        </p>
      )}

      {coins.length > 0 && (
        <ol className={stale ? 'trend-list is-dim' : 'trend-list'}>
          {coins.map((c, i) => (
            <li key={c.id}>
              <span className="trend-rank">{i + 1}</span>
              <span className="trend-name">
                <strong>{c.symbol}</strong>
                <span className="muted">
                  {c.name}
                  {c.rank !== null && ` · 市值第 ${c.rank}`}
                </span>
              </span>
              <span className="trend-price">
                <span>${fmtPrice(c.priceUsd)}</span>
                {Number.isFinite(c.changePct) ? <Delta pct={c.changePct} /> : <span className="muted">—</span>}
              </span>
              <span className="trend-heat">
                {exchanges.map((ex) => (
                  <ExchangeHeat key={ex.adapter.id} data={ex} symbol={c.symbol} />
                ))}
                {absentFrom(exchanges, c.symbol).length > 0 && (
                  <span className="trend-absent">{absentFrom(exchanges, c.symbol).join('、')} 未進成交額前 50</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
