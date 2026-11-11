import type { Config } from './config.js';
import { Api, ensure, formatWei, quantity, type Direction } from './api.js';

export class Checks {
  constructor(private readonly cfg: Config, private readonly api: Api,
    private readonly options: { preservePartial?: boolean; balanceBlock?: number } = {}) {}
  async connectivity() {
    const chainId = BigInt(quantity(await this.api.rpc('eth_chainId', []))).toString();
    ensure(chainId === '1', 'expected Ethereum Mainnet chainId 1');
    return { chainId, network: 'Ethereum Mainnet', blockNumber: await this.api.blockNumber() };
  }
  async balance() {
    const blockNumber = this.options.balanceBlock ?? await this.api.blockNumber();
    const wei = BigInt(quantity(await this.api.rpc('eth_getBalance', [this.cfg.address, `0x${blockNumber.toString(16)}`]))).toString();
    return { address: this.cfg.address, blockNumber, wei, eth: formatWei(wei) };
  }
  private async endBlock() {
    const end = this.cfg.endBlock ?? await this.api.blockNumber();
    ensure(end >= this.cfg.startBlock, 'START_BLOCK is after snapshot block');
    return end;
  }
  async transactions() {
    // Etherscan-only runs can avoid an Alchemy dependency by setting END_BLOCK.
    const endBlock = await this.endBlock();
    const rows = new Map<string, { hash: string; blockNumber: string; timestamp: string; from: string; to: string;
      valueWei: string; valueEth: string; failed: boolean }>();
    const fingerprints = new Set<string>();
    let pages = 0; let complete = false; let stopReason = 'maxPages'; let nextPage: number | null = null;
    let error: string | undefined;
    try {
    for (let page = 1; page <= this.cfg.txMaxPages; page++) {
      // A conservative result-window guard, not a claim of provider history completeness.
      if (page * this.cfg.txPageSize > 10000) { stopReason = 'resultWindow'; nextPage = page; break; }
      const raw = await this.api.txPage(page, endBlock); pages++;
      const fingerprint = raw.map(tx => tx.hash.toLowerCase()).join(',');
      ensure(!raw.length || !fingerprints.has(fingerprint), 'repeated transaction page');
      fingerprints.add(fingerprint);
      let consumed = 0;
      for (const tx of raw) {
        if (rows.size === this.cfg.txLimit) break;
        ensure(BigInt(tx.blockNumber) >= BigInt(this.cfg.startBlock) && BigInt(tx.blockNumber) <= BigInt(endBlock), 'transaction outside block range');
        ensure([tx.from, tx.to].some(a => a.toLowerCase() === this.cfg.address.toLowerCase()), 'transaction outside address filter');
        rows.set(tx.hash.toLowerCase(), { hash: tx.hash, blockNumber: tx.blockNumber, timestamp: tx.timeStamp,
          from: tx.from, to: tx.to, valueWei: tx.value, valueEth: formatWei(tx.value), failed: tx.isError === '1' });
        consumed++;
      }
      if (consumed === raw.length && raw.length < this.cfg.txPageSize) { complete = true; stopReason = 'exhausted'; break; }
      nextPage = consumed < raw.length ? page : page + 1;
      if (rows.size >= this.cfg.txLimit) { stopReason = 'limit'; break; }
    }
    } catch (failure) {
      if (!this.options.preservePartial) throw failure;
      error = failure instanceof Error ? failure.message : 'Query failed'; stopReason = 'error';
    }
    return { address: this.cfg.address, startBlock: this.cfg.startBlock, endBlock, sort: 'desc', count: rows.size,
      ...(error ? { error } : {}),
      pages, complete, stopReason, nextPage: complete ? null : nextPage,
      note: 'complete covers only normal transactions in the configured block range; duplicates are removed by hash',
      transactions: [...rows.values()] };
  }
  private async transferDirection(direction: Direction, endBlock: number) {
    const rows = new Map<string, Record<string, unknown>>();
    const cursors = new Set<string>();
    const fingerprints = new Set<string>();
    let pageKey: string | undefined; let pages = 0; let complete = false; let stopReason = 'maxPages';
    let replayCurrentPage = false;
    let error: string | undefined;
    try {
    for (let page = 0; page < this.cfg.transferMaxPages; page++) {
      const result = await this.api.transferPage(direction, endBlock, pageKey); pages++;
      if (result.pageKey) {
        ensure(!cursors.has(result.pageKey), 'repeated pageKey'); cursors.add(result.pageKey);
      }
      const fingerprint = JSON.stringify(result.transfers.map(tx => tx.uniqueId).sort());
      ensure(!result.transfers.length || !fingerprints.has(fingerprint), 'repeated transfer page');
      fingerprints.add(fingerprint);
      let consumed = 0;
      for (const tx of result.transfers) {
        if (rows.size === this.cfg.transferLimit) break;
        ensure(BigInt(tx.blockNum) >= BigInt(this.cfg.startBlock) && BigInt(tx.blockNum) <= BigInt(endBlock), 'transfer outside block range');
        const party = direction === 'incoming' ? tx.to : tx.from;
        ensure(party?.toLowerCase() === this.cfg.address.toLowerCase(), 'transfer outside direction filter');
        rows.set(tx.uniqueId, { id: tx.uniqueId, hash: tx.hash, blockNumber: BigInt(tx.blockNum).toString(),
          direction, from: tx.from, to: tx.to, category: tx.category, asset: tx.asset,
          approximateValue: tx.value, rawValue: tx.rawContract.value, decimalsHex: tx.rawContract.decimal,
          tokenAddress: tx.rawContract.address });
        consumed++;
      }
      if (consumed < result.transfers.length) { replayCurrentPage = true; stopReason = 'limit'; break; }
      pageKey = result.pageKey;
      if (!pageKey) { complete = true; stopReason = 'exhausted'; break; }
      if (rows.size >= this.cfg.transferLimit) { stopReason = 'limit'; break; }
    }
    } catch (failure) {
      if (!this.options.preservePartial) throw failure;
      error = failure instanceof Error ? failure.message : 'Query failed'; stopReason = 'error';
    }
    return { count: rows.size, pages, complete, stopReason, nextPageKey: complete ? null : pageKey ?? null,
      ...(error ? { error } : {}),
      replayCurrentPage, byCategory: {
        external: [...rows.values()].filter(t => t.category === 'external').length,
        internal: [...rows.values()].filter(t => t.category === 'internal').length,
        erc20: [...rows.values()].filter(t => t.category === 'erc20').length,
      }, transfers: [...rows.values()] };
  }
  async transfers() {
    const endBlock = await this.endBlock();
    return { address: this.cfg.address, startBlock: this.cfg.startBlock, endBlock,
      incoming: await this.transferDirection('incoming', endBlock),
      outgoing: await this.transferDirection('outgoing', endBlock) };
  }
}
