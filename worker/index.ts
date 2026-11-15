// Cloudflare Worker entry. Static files in dist/ are served by the platform;
// this code runs only for /api/* (see run_worker_first in wrangler.jsonc).
import { proxyPionex } from '../server/pionexProxy';

const PREFIX = '/api/pionex/';

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(PREFIX)) {
      return proxyPionex(request, pathname.slice(PREFIX.length).split('/'));
    }
    return new Response('Not found', { status: 404 });
  },
};
