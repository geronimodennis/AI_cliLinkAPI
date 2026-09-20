import type { Config } from '../config.js';
import type { Provider } from './types.js';
import { CodexProvider } from './codex.js';
export function createProvider(config: Config, filename: string): Provider { return new CodexProvider(config, filename); }
