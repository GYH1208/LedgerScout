import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Api } from './api.js';
import { Checks } from './checks.js';
import { Transport, RequestScheduler, type RequestScope } from './http.js';
import { Results, redact } from './output.js';

export type QueryKind = 'get_eth_balance' | 'list_normal_transactions' | 'list_asset_transfers';
export type QueryResult = {
  schemaVersion: 1; queryId: string; kind: QueryKind; sessionId: string; runId: string; toolCallId: string;
  network: 'Ethereum Mainnet'; address: string; range: { startBlock?: number; endBlock?: number; blockNumber?: number };
  fetchedAt: string; status: 'ok' | 'partial' | 'error'; data: Record<string, any>;
  completeness: { complete: boolean; stopReason: string; incoming?: Record<string, unknown>; outgoing?: Record<string, unknown> };
  evidenceRefs: { id: string; provider: string; method: string }[]; warnings: string[];
  error?: { code: string; message: string };
};
export type QueryContext = RequestScope & { sessionId: string; runId: string; toolCallId: string };
export const isQueryKind = (name: string): name is QueryKind => ['get_eth_balance', 'list_normal_transactions', 'list_asset_transfers'].includes(name);
const sharedScheduler = new RequestScheduler();
const invalid = (): never => { throw new Error('INVALID_ARGUMENT: invalid or unsupported query arguments'); };

export function validateQuery(name: string, args: Record<string, unknown>) {
  if (!isQueryKind(name)) invalid();
  const allowed = name === 'get_eth_balance' ? ['address', 'blockNumber'] : ['address', 'startBlock', 'endBlock', 'pageSize', 'maxPages', 'maxRecords'];
  if (!args || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) invalid();
  if (typeof args.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(args.address)) invalid();
  const integer = (key: string, fallback: number | undefined, min: number, max: number) => {
    const value = args[key] ?? fallback;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
    return value as number;
  };
  const startBlock = integer('startBlock', 0, 0, Number.MAX_SAFE_INTEGER)!;
  const endBlock = integer('endBlock', undefined, startBlock, Number.MAX_SAFE_INTEGER);
  return { address: args.address as string, startBlock, endBlock,
    blockNumber: integer('blockNumber', undefined, 0, Number.MAX_SAFE_INTEGER),
    pageSize: integer('pageSize', 25, 1, 100)!, maxPages: integer('maxPages', 2, 1, 4)!, maxRecords: integer('maxRecords', 50, 1, 200)! };
}

export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/budget|exhausted|limit exceeded/i.test(message)) return 'BUDGET_EXHAUSTED';
  if (/cancel|abort/i.test(message)) return 'CANCELLED';
  if (/INVALID_ARGUMENT|invalid.*argument/i.test(message)) return 'INVALID_ARGUMENT';
  if (/401|403|key|not enabled/i.test(message)) return 'AUTH_ERROR';
  if (/daily|monthly|quota|credits.*exhausted/i.test(message)) return 'QUOTA_EXHAUSTED';
  if (/429|rate.?limit/i.test(message)) return 'RATE_LIMIT';
  if (/timeout/i.test(message)) return 'TIMEOUT';
  if (/network|fetch/i.test(message)) return 'NETWORK_ERROR';
  return 'PROVIDER_RESPONSE_INVALID';
}

export class QueryService {
  private queries = new Map<string, QueryResult>();
  private snapshot?: number;
  private secrets: string[];
  constructor(private options: {
    config: Config; outputDirectory: string; fetch?: typeof fetch; scheduler?: RequestScheduler;
    additionalSecrets?: string[]; initialResults?: QueryResult[];
    initialSnapshot?: number; onSnapshot?: (block: number) => Promise<void>;
  }) {
    if (options.initialSnapshot !== undefined && (!Number.isSafeInteger(options.initialSnapshot) || options.initialSnapshot < 0)) invalid();
    this.snapshot = options.initialSnapshot;
    this.secrets = [options.config.alchemyKey, options.config.etherscanKey, ...(options.additionalSecrets ?? [])].filter(Boolean);
    for (const q of options.initialResults ?? []) this.queries.set(q.queryId, q);
  }
  all(): QueryResult[] { return [...this.queries.values()]; }
  async query(name: string, args: Record<string, unknown>, context: QueryContext): Promise<QueryResult> {
    const input = validateQuery(name, args);
    context.signal?.throwIfAborted();
    const queryId = `q_${randomUUID()}`;
    const directory = join(this.options.outputDirectory, queryId);
    const raw = new Results(directory, this.secrets);
    const cfg: Config = { ...this.options.config, address: input.address, startBlock: input.startBlock,
      endBlock: input.endBlock, txPageSize: input.pageSize, txMaxPages: input.maxPages, txLimit: input.maxRecords,
      transferPageSize: input.pageSize, transferMaxPages: input.maxPages, transferLimit: input.maxRecords };
    const transport = new Transport(cfg, record => raw.save(record.label, { ...record, queryId,
      sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId }).then(() => {}), {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      scheduler: this.options.scheduler ?? sharedScheduler, scope: context,
    });
    const api = new Api(cfg, transport);
    const result: QueryResult = { schemaVersion: 1, queryId, kind: name as QueryKind,
      sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId,
      network: 'Ethereum Mainnet', address: input.address, range: {}, fetchedAt: new Date().toISOString(),
      status: 'error', data: {}, completeness: { complete: false, stopReason: 'error' },
      evidenceRefs: [{ id: `${queryId}:data`, provider: name === 'list_normal_transactions' ? 'Etherscan V2' : 'Alchemy',
        method: name === 'get_eth_balance' ? 'eth_getBalance' : name === 'list_normal_transactions' ? 'account/txlist' : 'alchemy_getAssetTransfers' }], warnings: [] };
    try {
      // One validated snapshot per run. Explicit Etherscan windows can work without Alchemy.
      if (this.snapshot === undefined && !(name === 'list_normal_transactions' && input.endBlock !== undefined && !cfg.alchemyKey)) {
        const snapshot = (await new Checks(cfg, api).connectivity()).blockNumber;
        await this.options.onSnapshot?.(snapshot);
        this.snapshot = snapshot;
      }
      const end = input.endBlock ?? this.snapshot!;
      const balanceBlock = input.blockNumber ?? this.snapshot!;
      if (name === 'get_eth_balance') {
        if (!Number.isSafeInteger(balanceBlock) || balanceBlock > this.snapshot!) invalid();
        result.range = { blockNumber: balanceBlock };
      } else {
        if (!Number.isSafeInteger(end) || end < input.startBlock || (this.snapshot !== undefined && end > this.snapshot)) invalid();
        result.range = { startBlock: input.startBlock, endBlock: end };
      }
      const checks = new Checks({ ...cfg, endBlock: end }, api, { preservePartial: true, balanceBlock });
      result.data = name === 'get_eth_balance' ? await checks.balance() : name === 'list_normal_transactions' ? await checks.transactions() : await checks.transfers();
      if (name === 'get_eth_balance') result.completeness = { complete: true, stopReason: 'exhausted' };
      else if (name === 'list_normal_transactions') result.completeness = { complete: result.data.complete, stopReason: result.data.stopReason };
      else result.completeness = { complete: result.data.incoming.complete && result.data.outgoing.complete,
        stopReason: result.data.incoming.complete && result.data.outgoing.complete ? 'exhausted' : 'partial',
        incoming: this.directionSummary(result.data.incoming), outgoing: this.directionSummary(result.data.outgoing) };
      const errors = [result.data.error, result.data.incoming?.error, result.data.outgoing?.error].filter(Boolean);
      const count = result.data.count ?? ((result.data.incoming?.count ?? 0) + (result.data.outgoing?.count ?? 0));
      result.status = result.completeness.complete ? 'ok' : errors.length && !count ? 'error' : 'partial';
      if (errors.length) result.error = { code: errorCode(errors[0]), message: errors.join('; ') };
      if (!result.completeness.complete) result.warnings.push('仅返回已获取的部分历史，不能视为完整记录。');
    } catch (error) {
      result.error = { code: errorCode(error), message: error instanceof Error ? error.message : 'Query failed' };
    }
    result.fetchedAt = new Date().toISOString();
    const clean = redact(result, this.secrets) as QueryResult;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'query.json'), JSON.stringify(clean, null, 2) + '\n', { flag: 'wx' });
    } catch { throw new Error('EVIDENCE_WRITE_FAILED: unable to persist query evidence'); }
    this.queries.set(queryId, clean);
    return clean;
  }
  private directionSummary(value: Record<string, any>) {
    const { transfers: _rows, nextPageKey: _cursor, ...summary } = value; return summary;
  }
  preview(query: QueryResult) {
    const data = { ...query.data };
    if (data.transactions) data.transactions = data.transactions.slice(0, 3);
    for (const direction of ['incoming', 'outgoing']) if (data[direction]) {
      data[direction] = { ...this.directionSummary(data[direction]), transfers: data[direction].transfers.slice(0, 3) };
    }
    const { sessionId: _session, runId: _run, toolCallId: _call, ...rest } = query;
    return { ...rest, data };
  }
  readEvidence(queryId: string, collection: string, offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid();
    const q = this.queries.get(queryId);
    if (!q) throw new Error('INVALID_ARGUMENT: query evidence is not in this session');
    const records = collection === 'transactions' ? q.data.transactions : collection === 'incoming' || collection === 'outgoing' ? q.data[collection]?.transfers : undefined;
    if (!Array.isArray(records)) invalid();
    return { queryId, collection, offset, records: records.slice(offset, offset + limit), totalAvailable: records.length,
      hasMore: offset + limit < records.length, upstreamComplete: q.completeness.complete };
  }
}
export const createQueryService = (options: ConstructorParameters<typeof QueryService>[0]) => new QueryService(options);
