import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensCandidates, normalizeEnsName, UNIVERSAL_RESOLVER, type EnsResolution } from '@ledgerscout/chain-data';
import { validId } from './session.js';
export type EnsReference = { resolutionId: string; runId: string; hash: string };
export const hashEns = (proof: EnsResolution) => createHash('sha256').update(JSON.stringify(proof)).digest('hex');
export const referenceEns = (proof: EnsResolution): EnsReference => ({ resolutionId: proof.resolutionId, runId: proof.runId, hash: hashEns(proof) });
export function extractEnsTargets(input: string): { names: { name: string; originalName: string }[]; error?: string } {
  const names: { name: string; originalName: string }[] = [];
  try {
    const candidates = ensCandidates(input);
    let remaining = input;
    for (const candidate of candidates) remaining = remaining.replace(candidate, '');
    if (/\.eth/i.test(remaining)) throw new Error();
    for (const originalName of candidates) {
      if (/^(?:请)?(?:查询|分析|看看|查一下|查看|查)(?=[a-zA-Z0-9])/.test(originalName)) throw new Error();
      const name = normalizeEnsName(originalName);
      if (!names.some(n => n.name === name)) names.push({ name, originalName });
    }
    if (names.length > 4) throw new Error();
    return { names };
  } catch { return { names: [], error: 'ENS名称无效或不明确；请提供完整 .eth 名称，与中文指令间留空格，每轮最多4个名称。' }; }
}
export async function loadEnsProofs(base: string, sessionId: string, lineage: string[], refs: EnsReference[]): Promise<EnsResolution[]> {
  if (!Array.isArray(refs) || refs.length > 12) throw new Error('Invalid ENS evidence references');
  const proofs: EnsResolution[] = [];
  for (const ref of refs) {
    if (!ref || !validId(ref.runId) || !lineage.includes(ref.runId) || !validId(ref.resolutionId) || !/^e_/.test(ref.resolutionId) || !/^[a-f0-9]{64}$/.test(ref.hash)) throw new Error('Invalid ENS evidence reference');
    const path = join(base, sessionId, ref.runId, 'resolutions', ref.resolutionId, 'resolution.json');
    if ((await stat(path)).size > 16000) throw new Error('Invalid ENS evidence size');
    const p = JSON.parse(await readFile(path, 'utf8')) as EnsResolution;
    if (hashEns(p) !== ref.hash || p.version !== 1 || p.sessionId !== sessionId || p.runId !== ref.runId || p.resolutionId !== ref.resolutionId ||
      p.network !== 'Ethereum Mainnet' || p.universalResolver !== UNIVERSAL_RESOLVER || normalizeEnsName(p.name) !== p.name ||
      normalizeEnsName(p.originalName) !== p.name || !['resolved', 'not_found', 'unsupported', 'error'].includes(p.status) || !Number.isFinite(Date.parse(p.resolvedAt))) throw new Error('Invalid ENS query evidence');
    if (p.status === 'resolved' && (!/^0x[0-9a-f]{40}$/i.test(p.address ?? '') || /^0x0{40}$/.test(p.address!) ||
      !/^0x[0-9a-f]{40}$/i.test(p.resolver ?? '') || /^0x0{40}$/.test(p.resolver!) || !Number.isSafeInteger(p.blockNumber) || p.blockNumber! < 0)) throw new Error('Invalid ENS mapping evidence');
    proofs.push(p);
  }
  return proofs;
}
export function ensHeader(proofs: EnsResolution[]): string {
  return proofs.map(p => `ENS ${p.originalName}${p.originalName !== p.name ? `（规范化 ${p.name}）` : ''} → ${p.address ?? p.error?.message ?? '解析失败'}\n` +
    `Ethereum Mainnet 区块 ${p.blockNumber ?? '未取得'} | 解析时间 ${p.resolvedAt} | 证据 ${p.resolutionId}`).join('\n\n');
}
