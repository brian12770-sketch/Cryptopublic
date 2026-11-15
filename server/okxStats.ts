// Proxy for two OKX statistics endpoints. OKX serves its market data with CORS
// headers but not these (verified 2026-11-15), so a browser cannot call them.
// Read-only by construction: GET only, two fixed upstream paths, and the only
// thing a caller can choose is which USDT perpetual to ask about.

const UPSTREAM = 'https://www.okx.com/api/v5/rubik/stat/';
const ROUTES: Record<string, string> = {
  // [ts, oi (contracts), oiCcy (coins), oiUsd] per 15-minute period
  oi: 'contracts/open-interest-history?period=15m&limit=8',
  // [ts, sell, buy] in USDT per 15-minute period
  taker: 'taker-volume-contract?period=15m&unit=2&limit=4',
};
const INSTRUMENT = /^[A-Z0-9]{1,20}-USDT-SWAP$/;
/** The figures change once per 15 minutes; a short cache spares OKX repeat calls. */
const TTL = 20;

/** `kind` is the path segment after /api/okx/. */
export async function proxyOkxStats(request: Request, kind: string): Promise<Response> {
  if (request.method !== 'GET') return text(405, 'GET only');
  const route = ROUTES[kind];
  const instId = new URL(request.url).searchParams.get('instId') ?? '';
  if (!route) return text(404, 'Not proxied');
  if (!INSTRUMENT.test(instId)) return text(400, 'instId must be a USDT perpetual, e.g. BTC-USDT-SWAP');

  let res: Response;
  try {
    res = await fetch(`${UPSTREAM}${route}&instId=${instId}`, {
      headers: { accept: 'application/json', 'user-agent': 'perp-heat-dashboard/1.0' },
      cf: { cacheTtl: TTL, cacheEverything: true },
    } as RequestInit);
  } catch {
    return text(502, 'OKX unreachable');
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      'cache-control': `public, max-age=${TTL}`,
    },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
