import type { Adapter } from '../types';
import { binance } from './binance';
import { okx } from './okx';

// Pionex is switched off: its API rejects requests from Cloudflare Workers, so
// the proxy needs a host elsewhere. The adapter in ./pionex.ts and the proxy in
// server/pionexProxy.ts are kept, tested, and ready to wire back in.
export const ADAPTERS: Adapter[] = [binance, okx];
