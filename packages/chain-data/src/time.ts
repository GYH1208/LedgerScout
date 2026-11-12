import { ensure, type Api } from './api.js';
export type TimeWindow = {
  startTimestamp: number; endTimestamp: number; referenceTimestamp: number;
  timezone: 'Asia/Shanghai'; clipped: boolean;
};
export type BlockTime = { number: number; timestamp: number };
export type ResolvedTimeWindow = TimeWindow & {
  startBlock: number; endBlock: number; snapshot: number; sourceQueryId: string; proof: BlockTime[];
};
export function validTimeWindow(value: unknown): value is TimeWindow {
  const w = value as TimeWindow | undefined;
  return !!w && [w.startTimestamp, w.endTimestamp, w.referenceTimestamp].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000) &&
    w.startTimestamp <= w.endTimestamp && w.endTimestamp <= w.referenceTimestamp && w.timezone === 'Asia/Shanghai' && typeof w.clipped === 'boolean';
}
export function sameTimeWindow(a: TimeWindow, b: TimeWindow) {
  return ['startTimestamp', 'endTimestamp', 'referenceTimestamp', 'timezone', 'clipped'].every(k => a[k as keyof TimeWindow] === b[k as keyof TimeWindow]);
}
export function validResolvedWindow(w: ResolvedTimeWindow): boolean {
  if (!validTimeWindow(w) || ![w.startBlock, w.endBlock, w.snapshot].every(n => Number.isSafeInteger(n) && n >= 0) ||
    w.startBlock < 1 || w.startBlock > w.endBlock || w.endBlock > w.snapshot || !/^q_[A-Za-z0-9_-]+$/.test(w.sourceQueryId) ||
    !Array.isArray(w.proof) || w.proof.length > 4 || w.proof.some(b => !b || ![b.number, b.timestamp].every(n => Number.isSafeInteger(n) && n >= 0)) ||
    new Set(w.proof.map(b => b.number)).size !== w.proof.length) return false;
  const timestamp = (n: number) => w.proof.find(b => b.number === n)?.timestamp;
  return timestamp(w.startBlock) !== undefined && timestamp(w.startBlock)! >= w.startTimestamp &&
    timestamp(w.startBlock - 1) !== undefined && timestamp(w.startBlock - 1)! < w.startTimestamp &&
    timestamp(w.endBlock) !== undefined && timestamp(w.endBlock)! <= w.endTimestamp &&
    (w.endBlock === w.snapshot || timestamp(w.endBlock + 1) !== undefined && timestamp(w.endBlock + 1)! > w.endTimestamp);
}
export async function resolveTimeWindow(api: Pick<Api, 'blockByTime' | 'blockTime'>, window: TimeWindow,
  snapshot: number, sourceQueryId: string): Promise<ResolvedTimeWindow> {
  ensure(validTimeWindow(window) && window.startTimestamp >= 1, 'invalid time window');
  const startBlock = await api.blockByTime(window.startTimestamp - 1) + 1;
  const endBlock = Math.min(await api.blockByTime(window.endTimestamp), snapshot);
  ensure(startBlock >= 1 && startBlock <= endBlock && endBlock <= snapshot, 'requested time window has no available mined blocks');
  const proof: BlockTime[] = [];
  for (const n of new Set([startBlock - 1, startBlock, endBlock, ...(endBlock < snapshot ? [endBlock + 1] : [])])) proof.push(await api.blockTime(n));
  const resolved = { ...window, startBlock, endBlock, snapshot, sourceQueryId, proof };
  ensure(validResolvedWindow(resolved), 'timestamp boundary verification failed');
  return resolved;
}
