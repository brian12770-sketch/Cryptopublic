/** A fetch failure the UI can explain in plain words. */
export class FetchError extends Error {
  kind: 'network' | 'http' | 'shape';
  status?: number;

  constructor(kind: FetchError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.status = status;
  }
}

export async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: 'no-store' });
  } catch (err) {
    if (signal.aborted) throw err;
    // Browsers report CORS blocks, DNS failures and offline all as TypeError.
    throw new FetchError('network', '無法連線（網路中斷，或被瀏覽器的跨網域規則擋下）');
  }
  if (!res.ok) {
    throw new FetchError('http', describeStatus(res.status), res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new FetchError('shape', '回傳內容不是預期的 JSON');
  }
}

function describeStatus(status: number): string {
  if (status === 451 || status === 403) return `交易所拒絕這個地區或網路的連線（HTTP ${status}）`;
  if (status === 429 || status === 418) return `被交易所限流（HTTP ${status}），稍後自動重試`;
  if (status >= 500) return `交易所伺服器錯誤（HTTP ${status}）`;
  return `請求失敗（HTTP ${status}）`;
}

export function shapeError(what: string): FetchError {
  return new FetchError('shape', `${what} 的回傳格式和預期不同`);
}

/** Parse a numeric string; NaN for anything that is not a finite number. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || v.trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
