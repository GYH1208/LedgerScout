import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../../../data-validation/', import.meta.url));
export type Env = Record<string, string | undefined>;
export function parseConfig(env: Env) {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return value;
  };
  const address = env.TEST_ADDRESS ?? '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('TEST_ADDRESS must be a 20-byte 0x address');
  const key = (name: string) => {
    const value = env[name]?.trim() ?? '';
    if (value && (/[\s\x00-\x1f]/.test(value) || /^(YOUR_|replace|insert|paste|<)/i.test(value))) {
      throw new Error(`${name} is invalid or a placeholder; edit it locally`);
    }
    return value;
  };
  const startBlock = number('START_BLOCK', 0, 0, Number.MAX_SAFE_INTEGER);
  const endBlock = env.END_BLOCK?.trim() ? number('END_BLOCK', 0, startBlock, Number.MAX_SAFE_INTEGER) : undefined;
  const retryBaseMs = number('RETRY_BASE_MS', 1000, 1, 60000);
  const retryMaxMs = number('RETRY_MAX_MS', 10000, retryBaseMs, 60000);
  return {
    alchemyKey: key('ALCHEMY_API_KEY'), etherscanKey: key('ETHERSCAN_API_KEY'), address,
    timeoutMs: number('REQUEST_TIMEOUT_MS', 15000, 1, 120000),
    maxRetries: number('MAX_RETRIES', 3, 0, 5), retryBaseMs, retryMaxMs,
    intervalMs: number('REQUEST_INTERVAL_MS', 600, 0, 10000), startBlock, endBlock,
    txPageSize: number('TX_PAGE_SIZE', 25, 1, 1000),
    txMaxPages: number('TX_MAX_PAGES', 2, 1, 100), txLimit: number('TX_LIMIT', 50, 1, 10000),
    transferPageSize: number('TRANSFER_PAGE_SIZE', 25, 1, 1000),
    transferMaxPages: number('TRANSFER_MAX_PAGES', 2, 1, 100),
    transferLimit: number('TRANSFER_LIMIT', 50, 1, 10000),
  };
}
export type Config = ReturnType<typeof parseConfig>;

// Parse into a local object. Never mutate process.env or print dotenv contents.
export function loadConfig(env: Env = process.env, files = [
  resolve(projectRoot, '../.env'), resolve(projectRoot, '.env'),
]): Config {
  let merged: Env = {};
  for (const file of files) {
    try { merged = { ...merged, ...parseEnv(readFileSync(file, 'utf8')) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to read a local .env file; check its syntax and permissions');
      }
    }
  }
  return parseConfig({ ...merged, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) });
}
