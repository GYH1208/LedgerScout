import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Api } from './api.js';
import { Checks } from './checks.js';
import { ApiError, Transport, providerScheduler, type RequestScope } from './http.js';
import { Results, redact } from './output.js';
import { normalizeEnsName, encodeEnsCall, decodeEnsResult, ensSelector, UNIVERSAL_RESOLVER } from './ens-codec.js';
export * from './ens-codec.js';
export type EnsResolution = {
  version: 1; resolutionId: string; sessionId: string; runId: string; originalName: string; name: string;
  network: 'Ethereum Mainnet'; universalResolver: string; resolver?: string; address?: string; blockNumber?: number;
  resolvedAt: string; status: 'resolved' | 'not_found' | 'unsupported' | 'error'; error?: { code: string; message: string };
};
export class EnsService {
  private snapshot: number | undefined;
  constructor(private options: { config: Config; outputDirectory: string; fetch?: typeof fetch; secrets?: string[];
    initialSnapshot?: number; onSnapshot?: (block: number) => Promise<void> }) { this.snapshot = options.initialSnapshot; }
  async resolve(input: string, context: RequestScope & { sessionId: string; runId: string }): Promise<EnsResolution> {
    const name = normalizeEnsName(input); const resolutionId = `e_${randomUUID()}`;
    const directory = join(this.options.outputDirectory, resolutionId);
    const secrets = [this.options.config.alchemyKey, ...(this.options.secrets ?? [])].filter(Boolean);
    const raw = new Results(directory, secrets);
    const transport = new Transport(this.options.config, data => raw.save(data.label, { ...data, resolutionId,
      sessionId: context.sessionId, runId: context.runId }).then(() => {}), {
      scheduler: providerScheduler, scope: context, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
    const api = new Api(this.options.config, transport);
    const proof: EnsResolution = { version: 1, resolutionId, sessionId: context.sessionId, runId: context.runId,
      originalName: input, name, network: 'Ethereum Mainnet', universalResolver: UNIVERSAL_RESOLVER,
      status: 'error', resolvedAt: new Date().toISOString() };
    try {
      context.signal?.throwIfAborted();
      if (this.snapshot === undefined) {
        const block = (await new Checks(this.options.config, api).connectivity()).blockNumber;
        await this.options.onSnapshot?.(block); this.snapshot = block;
      }
      proof.blockNumber = this.snapshot;
      const result = decodeEnsResult(await api.rpc('eth_call', [{ to: UNIVERSAL_RESOLVER, data: encodeEnsCall(name) }, `0x${this.snapshot.toString(16)}`]));
      proof.resolver = result.resolver;
      if (result.address) { proof.status = 'resolved'; proof.address = result.address; }
      else { proof.status = 'not_found'; proof.error = { code: 'ENS_NO_ADDRESS', message: '名称未设置 Ethereum 地址记录。' }; }
    } catch (error) {
      const data = error instanceof ApiError ? error.rpcData?.toLowerCase() : undefined;
      const message = error instanceof Error ? error.message : '';
      if (data?.startsWith('0x' + ensSelector('ResolverNotFound(bytes)'))) {
        proof.status = 'not_found'; proof.error = { code: 'ENS_NOT_FOUND', message: '名称未找到可用解析器。' };
      } else if (data?.startsWith('0x556f1830') || /OffchainLookup/i.test(message)) {
        proof.status = 'unsupported'; proof.error = { code: 'ENS_OFFCHAIN_UNSUPPORTED', message: '此名称需要链下网关，当前版本只支持链上解析。' };
      } else proof.error = { code: /budget/i.test(message) ? 'BUDGET_EXHAUSTED' : /cancel|abort/i.test(message) ? 'CANCELLED' :
        /timeout/i.test(message) ? 'TIMEOUT' : 'ENS_RESOLUTION_FAILED', message: 'ENS解析失败；请检查网络、服务配置或名称解析器。' };
    }
    proof.resolvedAt = new Date().toISOString(); const clean = redact(proof, secrets) as EnsResolution;
    try { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'resolution.json'), JSON.stringify(clean, null, 2) + '\n', { flag: 'wx' }); }
    catch { throw new Error('EVIDENCE_WRITE_FAILED: unable to persist ENS evidence'); }
    return clean;
  }
}
