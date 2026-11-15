// Cloudflare Pages Function: same-origin proxy for Pionex public market data.
// Pionex sends no CORS headers, so the browser cannot call it directly.
// Read-only by construction: GET only, market endpoints only, no credentials.

const UPSTREAM = 'https://api.pionex.com/api/v1/market/';
const ALLOWED = new Set(['tickers', 'klines']);

interface Context {
  request: Request;
  params: { path?: string | string[] };
}

export async function onRequest({ request, params }: Context): Promise<Response> {
  if (request.method !== 'GET') return text(405, 'GET only');

  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  if (parts.length !== 2 || parts[0] !== 'market' || !ALLOWED.has(parts[1])) {
    return text(404, 'Not proxied');
  }

  const endpoint = parts[1];
  const upstream = new URL(UPSTREAM + endpoint);
  upstream.search = new URL(request.url).search;

  // Candles change once an hour; tickers must stay fresh.
  const ttl = endpoint === 'klines' ? 120 : 2;
  let res: Response;
  try {
    res = await fetch(upstream.toString(), {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    } as RequestInit);
  } catch {
    return text(502, 'Pionex unreachable');
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      'cache-control': `public, max-age=${ttl}`,
    },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
