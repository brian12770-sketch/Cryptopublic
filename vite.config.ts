import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Behind a corporate or sandbox proxy the dev server must tunnel through it.
const upstreamProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;

const agent = upstreamProxy ? new HttpsProxyAgent(upstreamProxy) : undefined;
const okxStats = 'https://www.okx.com';
const rubik = '/api/v5/rubik/stat';

export default defineConfig({
  plugins: [react()],
  server: {
    // These stand in for the Worker's proxies (server/*.ts) during development.
    proxy: {
      '/api/pionex': {
        target: 'https://api.pionex.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pionex/, '/api/v1'),
        agent,
      },
      '/api/okx/oi': {
        target: okxStats,
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/okx\/oi\?/, `${rubik}/contracts/open-interest-history?period=15m&limit=8&`),
        agent,
      },
      '/api/okx/taker': {
        target: okxStats,
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/okx\/taker\?/, `${rubik}/taker-volume-contract?period=15m&unit=2&limit=4&`),
        agent,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
