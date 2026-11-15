// Cloudflare Worker entry: serves the built site.
//
// The site's files are inlined into this script (see scripts/gen-assets.mjs)
// instead of using Workers static assets, so a deploy is one script upload
// authenticated by the API token alone. The static-assets upload needs a
// second, short-lived credential that the deploy environment cannot pass.
//
// There is no /api route here. Pionex rejects requests from Cloudflare Workers,
// so its proxy (server/pionexProxy.ts) has to run on a host outside Cloudflare.
import { ASSETS, type Asset } from './assets.generated';

function serve(asset: Asset, path: string, method: string): Response {
  const body =
    method === 'HEAD' ? null : asset.base64 ? Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0)) : asset.body;
  return new Response(body, {
    headers: {
      'content-type': asset.type,
      // Vite puts a content hash in every filename under /assets/.
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    const asset = ASSETS[pathname];
    if (asset) return serve(asset, pathname, request.method);
    // A missing hashed file is a real 404; anything else is the app shell.
    if (pathname.startsWith('/assets/')) return new Response('Not found', { status: 404 });
    const shell = ASSETS['/index.html'];
    return shell ? serve(shell, '/index.html', request.method) : new Response('Site not built', { status: 500 });
  },
};
