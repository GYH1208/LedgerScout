import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redact, type QueryResult } from '@ledgerscout/chain-data';
import { atomicJson, validId } from './session.js';
import type { ChatMessage, ModelReply } from './types.js';

export type Checkpoint = {
  version: 1; sessionId: string; runId: string; input: string; addresses: string[]; lineage: string[];
  limits: Record<string, number>; counts: { models: number; tools: number; http: number };
  tokenUsage: { source: 'provider'; inputTokens: number; outputTokens: number; totalTokens: number; reportedRequests: number; unknownRequests: number };
  messages: ChatMessage[]; reply?: ModelReply; completedTools: { id: string; content: string; isError: boolean }[];
  queryRefs: { runId: string; queryId: string; hash: string }[]; snapshot?: number;
  cache: [string, string][]; failures: [string, number][]; repairUsed: boolean;
  elapsedMs: number; reservedMs: number; closed: boolean; resumedBy?: string;
};
const hash = (q: QueryResult) => createHash('sha256').update(JSON.stringify(q)).digest('hex');
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const invalid = (): never => { throw new Error('Invalid or unavailable recovery checkpoint / query evidence'); };
async function readBounded(path: string, max: number) {
  if ((await stat(path)).size > max) invalid();
  return JSON.parse(await readFile(path, 'utf8'));
}

export class CheckpointStore {
  private tail = Promise.resolve();
  constructor(readonly path: string, private secrets: string[]) {}
  save(value: Checkpoint, queries: QueryResult[]): Promise<void> {
    value.queryRefs = queries.map(q => ({ runId: q.runId, queryId: q.queryId, hash: hash(q) }));
    const clean = redact(value, this.secrets);
    const json = JSON.stringify(clean);
    if (Buffer.byteLength(json, 'utf8') > 262144) return Promise.reject(new Error('Recovery checkpoint too large'));
    const snapshot = JSON.parse(json);
    this.tail = this.tail.then(() => atomicJson(this.path, snapshot));
    return this.tail;
  }
  static async load(base: string, sessionId: string, runId: string, caps: Record<string, number>) {
    if (!validId(sessionId) || !/^r_[A-Za-z0-9_-]+$/.test(runId) || !validId(runId)) invalid();
    const path = join(base, sessionId, runId, 'checkpoint.json');
    try {
      const c = await readBounded(path, 262144) as Checkpoint;
      if (c.version !== 1 || c.sessionId !== sessionId || c.runId !== runId || c.closed !== false || c.resumedBy) {
        if (c.resumedBy && validId(c.resumedBy)) throw new Error(`Run already resumed by ${c.resumedBy}`);
        invalid();
      }
      if (typeof c.input !== 'string' || !c.input || !Array.isArray(c.addresses) || !c.addresses.length ||
        c.addresses.some(a => typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) ||
        !Array.isArray(c.lineage) || c.lineage.length > 32 || !c.lineage.includes(runId) || c.lineage.some(id => !validId(id) || !/^r_/.test(id))) invalid();
      if (!c.limits || Object.keys(c.limits).length !== Object.keys(caps).length || Object.entries(caps).some(([k, cap]) => !integer(c.limits[k]) || c.limits[k]! < 1 || c.limits[k]! > cap)) invalid();
      if (c.lineage.at(-1) !== runId || new Set(c.lineage).size !== c.lineage.length) invalid();
      // A staged child cannot run until its parent has durably activated this exact ID.
      if (c.lineage.length > 1) {
        const parentId = c.lineage.at(-2)!;
        const parent = await readBounded(join(base, sessionId, parentId, 'checkpoint.json'), 262144) as Checkpoint;
        if (parent.sessionId !== sessionId || parent.runId !== parentId || parent.resumedBy !== runId) invalid();
      }
      try {
        const terminal = await readBounded(join(base, sessionId, runId, 'run-summary.json'), 16_000_000);
        if (terminal.resumable === false || ['completed', 'awaiting_user', 'exhausted'].includes(terminal.status)) invalid();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!c.counts || !['models', 'tools', 'http'].every(k => integer((c.counts as any)[k])) || c.counts.models > c.limits.maxModelRequests! || c.counts.tools > c.limits.maxToolCalls! || c.counts.http > c.limits.maxHttpRequests!) invalid();
      if (!c.tokenUsage || c.tokenUsage.source !== 'provider' || !['inputTokens', 'outputTokens', 'totalTokens', 'reportedRequests', 'unknownRequests'].every(k => integer((c.tokenUsage as any)[k])) || c.tokenUsage.reportedRequests + c.tokenUsage.unknownRequests !== c.counts.models) invalid();
      if (!Number.isFinite(c.elapsedMs) || c.elapsedMs < 0 || !integer(c.reservedMs) || c.reservedMs > c.limits.runTimeoutMs! ||
        c.snapshot !== undefined && !integer(c.snapshot) || typeof c.repairUsed !== 'boolean') invalid();
      if (!Array.isArray(c.messages) || !c.messages.length || c.messages.some(m => !['user', 'assistant', 'system', 'tool'].includes(m.role) || typeof m.content !== 'string')) invalid();
      if (c.reply && (typeof c.reply.content !== 'string' || c.reply.toolCalls && (!Array.isArray(c.reply.toolCalls) || c.reply.toolCalls.length > 128 || c.reply.toolCalls.some(t => typeof t.id !== 'string' || typeof t.name !== 'string' || !t.arguments || typeof t.arguments !== 'object' || Array.isArray(t.arguments))))) invalid();
      if (!Array.isArray(c.completedTools) || c.completedTools.length > 128 || c.completedTools.some(t => typeof t.id !== 'string' || typeof t.content !== 'string' || typeof t.isError !== 'boolean' || !c.reply?.toolCalls?.some(call => call.id === t.id))) invalid();
      if (!Array.isArray(c.cache) || !Array.isArray(c.failures) || c.cache.length > 12 || c.failures.length > 12 ||
        c.cache.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') ||
        c.failures.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !integer(p[1]))) invalid();
      if (!Array.isArray(c.queryRefs) || c.queryRefs.length > 44) invalid();
      const queries: QueryResult[] = [];
      for (const ref of c.queryRefs) {
        if (!validId(ref.runId) || !/^r_/.test(ref.runId) || !validId(ref.queryId) || !/^q_/.test(ref.queryId) || !/^[a-f0-9]{64}$/.test(ref.hash)) invalid();
        const q = await readBounded(join(base, sessionId, ref.runId, 'queries', ref.queryId, 'query.json'), 2_000_000) as QueryResult;
        if (q.sessionId !== sessionId || q.runId !== ref.runId || q.queryId !== ref.queryId || hash(q) !== ref.hash) invalid();
        queries.push(q);
      }
      if (c.cache.some(([, id]) => !queries.some(q => q.queryId === id && q.status !== 'error' && c.lineage.includes(q.runId)))) invalid();
      return { state: c, queries, path };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Run already resumed by ')) throw error;
      return invalid();
    }
  }
}
