import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Behind a corporate or sandbox proxy the dev server must tunnel through it.
const upstreamProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Stands in for the Worker (worker/index.ts) during development.
      '/api/pionex': {
        target: 'https://api.pionex.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pionex/, '/api/v1'),
        agent: upstreamProxy ? new HttpsProxyAgent(upstreamProxy) : undefined,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
