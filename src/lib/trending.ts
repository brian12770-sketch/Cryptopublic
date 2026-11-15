import { useEffect, useState } from 'react';
import { FetchError, getJson, isRecord, num, shapeError } from './http';

const URL = 'https://api.coingecko.com/api/v3/search/trending';
/** CoinGecko refreshes this list about every 10 minutes; the free tier is rate-limited. */
const REFRESH_MS = 5 * 60 * 1000;

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  /** Market-cap rank; null when CoinGecko has none. */
  rank: number | null;
  priceUsd: number;
  changePct: number;
}

export function parseTrending(json: unknown): TrendingCoin[] {
  if (!isRecord(json) || !Array.isArray(json.coins)) throw shapeError('CoinGecko 熱搜');
  const out: TrendingCoin[] = [];
  for (const entry of json.coins) {
    const item = isRecord(entry) ? entry.item : undefined;
    if (!isRecord(item)) continue;
    const { id, symbol, name } = item;
    if (typeof id !== 'string' || typeof symbol !== 'string' || typeof name !== 'string') continue;
    const data = isRecord(item.data) ? item.data : {};
    const change = isRecord(data.price_change_percentage_24h) ? data.price_change_percentage_24h.usd : undefined;
    const rank = num(item.market_cap_rank);
    out.push({
      id,
      symbol: symbol.toUpperCase(),
      name,
      rank: Number.isFinite(rank) ? rank : null,
      priceUsd: num(data.price),
      changePct: num(change),
    });
  }
  if (out.length === 0) throw shapeError('CoinGecko 熱搜');
  return out;
}

export interface TrendingData {
  coins: TrendingCoin[];
  lastOk: number | null;
  error: string | null;
}

export function useTrending(): TrendingData {
  const [state, setState] = useState<TrendingData>({ coins: [], lastOk: null, error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      if (document.hidden) return;
      try {
        const coins = parseTrending(await getJson(URL, ctrl.signal));
        setState({ coins, lastOk: Date.now(), error: null });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const message = err instanceof FetchError ? err.message : '未知錯誤';
        setState((prev) => ({ ...prev, error: message }));
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, []);

  return state;
}
