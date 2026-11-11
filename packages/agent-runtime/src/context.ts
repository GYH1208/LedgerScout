import { raceSignal } from '@ledgerscout/chain-data/control';
import type { ChatMessage, TokenCounter, ToolDefinition } from './types.js';

export type ContextMeasurement = { bytes: number; tokens: number; method: 'estimated' | 'local_tokenizer'; encoding?: string; revision?: string; fallback?: string };

export async function measureContext(messages: ChatMessage[], tools: ToolDefinition[] = [], counter?: TokenCounter,
  signal?: AbortSignal): Promise<ContextMeasurement> {
  signal?.throwIfAborted();
  const estimated = estimateContext(messages, tools);
  if (!counter) return estimated;
  try {
    const count = await raceSignal(counter(messages, tools, signal), signal);
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(count.tokens) || count.tokens < 1 || count.method !== 'local_tokenizer') throw new Error('Invalid token count');
    return { ...count, bytes: estimated.bytes };
  } catch {
    signal?.throwIfAborted();
    return { ...estimated, fallback: 'TOKENIZER_UNAVAILABLE' };
  }
}

export async function fitContextAsync(messages: ChatMessage[], maxBytes: number, options: {
  tools?: ToolDefinition[]; maxTokens: number; counter?: TokenCounter; signal?: AbortSignal;
}): Promise<{ messages: ChatMessage[]; measurement: ContextMeasurement }> {
  // First apply the cheap byte bound; then count only complete candidate rounds.
  let selected = fitContext(messages, maxBytes, { tools: options.tools });
  while (true) {
    const measurement = await measureContext(selected, options.tools, options.counter, options.signal);
    if (measurement.tokens <= options.maxTokens) return { messages: selected, measurement };
    const first = selected.findIndex(m => m.role === 'user');
    const second = selected.findIndex((m, i) => i > first && m.role === 'user');
    if (first < 0 || second < 0) throw new Error('CONTEXT_TOO_LARGE: 当前输入、工具定义或工具上下文过大，请缩小问题或查询范围。');
    selected = [...selected.slice(0, first), ...selected.slice(second)];
  }
}

export function estimateContext(messages: ChatMessage[], tools: ToolDefinition[] = []) {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  // Deliberately conservative: one token per UTF-8 byte plus framing allowance.
  // DeepSeek's server-side chat template can differ; this is not a billing count.
  return { bytes, tokens: bytes + 32 * messages.length + 64 * tools.length, method: 'estimated' as const };
}

/** Remove only complete older user rounds; never split the current tool-call batch. */
export function fitContext(messages: ChatMessage[], maxBytes = 24000,
  options: { tools?: ToolDefinition[]; maxTokens?: number } = {}): ChatMessage[] {
  const system = messages.filter(m => m.role === 'system');
  const prefix: ChatMessage[] = [];
  const rounds: ChatMessage[][] = [];
  for (const message of messages.filter(m => m.role !== 'system')) {
    if (!rounds.length && message.role !== 'user') { prefix.push(message); continue; }
    if (message.role === 'user') rounds.push([]);
    rounds.at(-1)!.push(message);
  }
  let result = [...system, ...prefix, ...rounds.flat()];
  const oversized = () => {
    const size = estimateContext(result, options.tools);
    return size.bytes > maxBytes || size.tokens > (options.maxTokens ?? Infinity);
  };
  while (oversized() && rounds.length > 1) {
    rounds.shift(); result = [...system, ...prefix, ...rounds.flat()];
  }
  if (oversized()) throw new Error('CONTEXT_TOO_LARGE: 当前输入、工具定义或工具上下文过大，请缩小问题或查询范围。');
  return result;
}
