import type { ChatMessage } from './types.js';

/** Remove only complete older user rounds; never split the current tool-call batch. */
export function fitContext(messages: ChatMessage[], maxBytes = 24000): ChatMessage[] {
  const system = messages.filter(m => m.role === 'system');
  const rounds: ChatMessage[][] = [];
  for (const message of messages.filter(m => m.role !== 'system')) {
    if (message.role === 'user' || !rounds.length) rounds.push([]);
    rounds.at(-1)!.push(message);
  }
  let result = [...system, ...rounds.flat()];
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes && rounds.length > 1) {
    rounds.shift(); result = [...system, ...rounds.flat()];
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) throw new Error('CONTEXT_TOO_LARGE: 当前输入或工具上下文过大，请缩小问题或查询范围。');
  return result;
}
