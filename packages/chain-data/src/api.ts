import type { Config } from './config.js';
import { ApiError, Transport } from './http.js';
import type { BlockTime } from './time.js';
import { isEnsEthCall } from './ens-codec.js';
import { isTokenEthCall } from './token.js';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApiError(`Response validation: ${message}`);
}
export function quantity(value: unknown): string {
  ensure(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), 'expected hex quantity');
  return value;
}
const decimal = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const rateLimited = (message: string) => !/\bdaily\b|\bmonthly\b|quota|credits? exhausted/i.test(message) &&
  /rate[ -]?limit|too many requests|compute units per second|\bthroughput\b/i.test(message);
export function formatWei(value: string): string {
  const wei = BigInt(value);
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wei / 10n ** 18n}${fraction ? '.' + fraction : ''}`;
}
export type Transaction = { hash: string; blockNumber: string; timeStamp: string; from: string;
  to: string; value: string; isError: string };
export type Transfer = { hash: string; uniqueId: string; blockNum: string; from: string; to: string | null;
  category: 'external' | 'internal' | 'erc20'; value: number | null; asset: string | null;
  rawContract: { value: string | null; decimal: string | null; address: string | null } };
export type Direction = 'incoming' | 'outgoing';
export class Api {
  private id = 0;
  constructor(private readonly cfg: Config, private readonly transport: Transport) {}
  async rpc(method: string, params: unknown[]): Promise<unknown> {
    if (!this.cfg.alchemyKey) throw new ApiError('Missing ALCHEMY_API_KEY; set it in local .env');
    ensure(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getBlockByNumber', 'alchemy_getAssetTransfers'].includes(method) ||
      method === 'eth_call' && (isEnsEthCall(params) || isTokenEthCall(params)), 'read-only method required');
    const id = ++this.id;
    return this.transport.request(method, new URL(`https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(this.cfg.alchemyKey)}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }, body => {
      ensure(isObject(body) && body.jsonrpc === '2.0', 'invalid JSON-RPC envelope');
      if (isObject(body.error)) {
        const message = typeof body.error.message === 'string' ? body.error.message : 'unspecified error';
        throw new ApiError(`Alchemy RPC ${String(body.error.code)}: ${message}`,
          body.error.code === 429 || rateLimited(message), typeof body.error.data === 'string' ? body.error.data : undefined);
      }
      ensure(body.id === id && Object.hasOwn(body, 'result') && !Object.hasOwn(body, 'error'), 'RPC id/result mismatch');
      return body.result;
    });
  }
  async blockNumber(): Promise<number> {
    const block = BigInt(quantity(await this.rpc('eth_blockNumber', [])));
    ensure(block <= BigInt(Number.MAX_SAFE_INTEGER), 'block exceeds integer range');
    return Number(block);
  }
  async blockTime(number: number): Promise<BlockTime> {
    ensure(Number.isSafeInteger(number) && number >= 0, 'invalid block number');
    const block = await this.rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
    ensure(isObject(block), 'missing boundary block');
    const height = BigInt(quantity(block.number)); const timestamp = BigInt(quantity(block.timestamp));
    ensure(height === BigInt(number) && timestamp <= BigInt(Number.MAX_SAFE_INTEGER), 'invalid boundary block');
    return { number, timestamp: Number(timestamp) };
  }
  async blockByTime(timestamp: number): Promise<number> {
    ensure(Number.isSafeInteger(timestamp) && timestamp >= 0, 'invalid timestamp');
    if (!this.cfg.etherscanKey) throw new ApiError('Missing ETHERSCAN_API_KEY; set it in local .env');
    const url = new URL('https://api.etherscan.io/v2/api');
    url.search = new URLSearchParams({ chainid: '1', module: 'block', action: 'getblocknobytime',
      timestamp: String(timestamp), closest: 'before', apikey: this.cfg.etherscanKey }).toString();
    return this.transport.request(`etherscan-block-by-time-${timestamp}`, url, { method: 'GET' }, body => {
      ensure(isObject(body) && typeof body.message === 'string', 'invalid Etherscan time envelope');
      if (body.status !== '1') {
        const message = `${body.message}: ${typeof body.result === 'string' ? body.result : 'unexpected result'}`;
        throw new ApiError(`Etherscan: ${message}`, rateLimited(message));
      }
      ensure(body.message === 'OK' && decimal(body.result), 'invalid timestamp block result');
      const block = Number(body.result); ensure(Number.isSafeInteger(block) && block >= 0, 'invalid timestamp block number');
      return block;
    });
  }
  async txPage(page: number, endBlock: number): Promise<Transaction[]> {
    if (!this.cfg.etherscanKey) throw new ApiError('Missing ETHERSCAN_API_KEY; set it in local .env');
    const url = new URL('https://api.etherscan.io/v2/api');
    url.search = new URLSearchParams({ chainid: '1', module: 'account', action: 'txlist',
      address: this.cfg.address, startblock: String(this.cfg.startBlock), endblock: String(endBlock),
      page: String(page), offset: String(this.cfg.txPageSize), sort: 'desc', apikey: this.cfg.etherscanKey }).toString();
    return this.transport.request(`etherscan-txlist-page-${page}`, url, { method: 'GET' }, body => {
      ensure(isObject(body) && typeof body.message === 'string', 'invalid Etherscan envelope');
      if (body.status === '0' && body.message.toLowerCase() === 'no transactions found' &&
        ((Array.isArray(body.result) && body.result.length === 0) || body.result === 'No transactions found')) return [];
      if (body.status !== '1') {
        const message = `${body.message}: ${typeof body.result === 'string' ? body.result : 'unexpected result'}`;
        throw new ApiError(`Etherscan: ${message}`, rateLimited(message));
      }
      ensure(body.message === 'OK' && Array.isArray(body.result), 'invalid Etherscan result');
      ensure(body.result.length <= this.cfg.txPageSize, 'txlist exceeds requested page size');
      for (const tx of body.result) {
        ensure(isObject(tx) && hash(tx.hash) && decimal(tx.blockNumber) && decimal(tx.timeStamp) &&
          address(tx.from) && (address(tx.to) || tx.to === '') && decimal(tx.value) &&
          (tx.isError === '0' || tx.isError === '1'), 'invalid transaction row');
      }
      return body.result as Transaction[];
    });
  }
  async transferPage(direction: Direction, endBlock: number, pageKey?: string): Promise<{ transfers: Transfer[]; pageKey?: string }> {
    const result = await this.rpc('alchemy_getAssetTransfers', [{ fromBlock: `0x${this.cfg.startBlock.toString(16)}`,
      toBlock: `0x${endBlock.toString(16)}`, [direction === 'incoming' ? 'toAddress' : 'fromAddress']: this.cfg.address,
      category: ['external', 'internal', 'erc20'], excludeZeroValue: true, withMetadata: true,
      order: 'desc', maxCount: `0x${this.cfg.transferPageSize.toString(16)}`, ...(pageKey ? { pageKey } : {}) }]);
    ensure(isObject(result) && Array.isArray(result.transfers), 'invalid transfer result');
    ensure(result.pageKey === undefined || typeof result.pageKey === 'string', 'invalid pageKey');
    ensure(result.transfers.length <= this.cfg.transferPageSize, 'transfers exceed requested page size');
    for (const tx of result.transfers) {
      ensure(isObject(tx) && hash(tx.hash) && typeof tx.uniqueId === 'string' && tx.uniqueId.length > 0 &&
        typeof tx.blockNum === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.blockNum) && address(tx.from) &&
        (address(tx.to) || tx.to === null) && ['external', 'internal', 'erc20'].includes(String(tx.category)) &&
        (tx.value === null || (typeof tx.value === 'number' && Number.isFinite(tx.value))) &&
        (tx.asset === null || typeof tx.asset === 'string') && isObject(tx.rawContract), 'invalid transfer row');
      for (const field of ['value', 'decimal', 'address']) {
        const v = tx.rawContract[field];
        ensure(v === null || (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)), 'invalid rawContract');
      }
    }
    return { transfers: result.transfers as Transfer[], ...(result.pageKey ? { pageKey: result.pageKey as string } : {}) };
  }
}
