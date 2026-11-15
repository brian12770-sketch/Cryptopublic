import type { Adapter } from '../types';
import { binance } from './binance';
import { okx } from './okx';
import { pionex } from './pionex';

export const ADAPTERS: Adapter[] = [binance, okx, pionex];
