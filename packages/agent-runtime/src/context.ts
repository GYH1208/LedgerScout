import type { ChatMessage, ToolDefinition } from './types.js';

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
