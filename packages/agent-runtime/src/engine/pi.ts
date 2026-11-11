import { runAgentLoop, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt,
  type AssistantMessage, type Message, type Model, type Usage,
} from '@earendil-works/pi-ai';
import { raceSignal } from '@ledgerscout/chain-data/control';
import type { ChatMessage, RuntimeTool, RequestModel, EngineEvent } from '../types.js';

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const model = { id: 'ledgerscout-adapter', name: 'LedgerScout', api: 'openai-completions', provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com', input: ['text'], reasoning: false, contextWindow: 12000, maxTokens: 2000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<'openai-completions'>;

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
}
function fromPi(messages: AgentMessage[]): ChatMessage[] {
  const system = getCurrentSystemPrompt(messages);
  const result: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') result.push({ role: 'user', content: text(m.content) });
    if (m.role === 'assistant') result.push({ role: 'assistant', content: text(m.content),
      toolCalls: m.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, name: c.name, arguments: c.arguments })) });
    if (m.role === 'toolResult') result.push({ role: 'tool', content: text(m.content), callId: m.toolCallId, name: m.toolName });
  }
  return result;
}
function toPi(m: ChatMessage): Message {
  const timestamp = Date.now();
  if (m.role === 'system' || m.role === 'user') return { role: m.role, content: m.content, timestamp };
  if (m.role === 'tool') return { role: 'toolResult', toolCallId: m.callId ?? '', toolName: m.name ?? '',
    content: [{ type: 'text', text: m.content }], isError: false, timestamp };
  return { role: 'assistant', content: [
    ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
    ...(m.toolCalls ?? []).map(c => ({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: c.arguments as any })),
  ], api: model.api, model: model.id, provider: model.provider, usage: emptyUsage(),
  stopReason: m.toolCalls?.length ? 'toolUse' : 'stop', timestamp };
}

export async function runPi(options: {
  messages: ChatMessage[]; tools: RuntimeTool[]; request: RequestModel; signal?: AbortSignal;
  maxRequests: number; onEvent?: (event: EngineEvent) => Promise<void>;
  followUp?: () => string | undefined;
}): Promise<{ content: string; messages: ChatMessage[]; requests: number; exhausted: boolean }> {
  let requests = 0; let exhausted = false; let fatal: unknown; let content = '';
  const tools: AgentTool<any>[] = options.tools.map(t => ({ ...t, label: t.name, executionMode: 'sequential',
    execute: async (id, args, signal) => {
      signal?.throwIfAborted();
      const value = await raceSignal(t.execute(args, id, signal), signal);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined };
    },
  }));
  const messages = options.messages.map(toPi);
  const result = await runAgentLoop([], { messages, tools }, {
    model, convertToLlm: m => m as Message[], toolExecution: 'sequential',
    finishTurn: () => requests >= options.maxRequests ? { action: 'end' } : undefined,
    getFollowUpMessages: async () => {
      const instruction = options.followUp?.();
      return instruction ? [{ role: 'user', content: instruction, timestamp: Date.now() }] : [];
    },
  }, async event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') content = text(event.message.content);
    await options.onEvent?.(event as unknown as EngineEvent);
  }, options.signal, (_model, context) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const assistant: AssistantMessage = { role: 'assistant', content: [], api: model.api, model: model.id,
        provider: model.provider, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() };
      try {
        options.signal?.throwIfAborted();
        if (requests >= options.maxRequests) throw new Error('Model request budget exhausted');
        requests++;
        const finalOnly = requests === options.maxRequests;
        const reply = await raceSignal(options.request({ messages: fromPi(context.messages),
          tools: finalOnly ? [] : getCurrentTools(context.messages).map(t => ({ ...t, parameters: { ...t.parameters } })), signal: options.signal, finalOnly }), options.signal);
        if (reply.content) assistant.content.push({ type: 'text', text: reply.content });
        if (finalOnly && reply.toolCalls?.length) exhausted = true;
        if (!finalOnly) for (const call of reply.toolCalls ?? []) assistant.content.push({ type: 'toolCall', ...call, arguments: call.arguments as any });
        if (reply.usage) assistant.usage = { ...emptyUsage(), input: reply.usage.inputTokens, output: reply.usage.outputTokens, totalTokens: reply.usage.totalTokens };
        assistant.stopReason = reply.truncated ? 'length' : assistant.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
        stream.push({ type: 'start', partial: assistant });
        stream.push({ type: 'done', reason: assistant.stopReason as 'stop' | 'length' | 'toolUse', message: assistant });
      } catch (error) {
        fatal = error; assistant.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        assistant.errorMessage = 'Model request failed';
        stream.push({ type: 'error', reason: assistant.stopReason, error: assistant });
      }
      stream.end(assistant);
    })();
    return stream;
  });
  if (fatal) throw fatal;
  if (requests >= options.maxRequests && !content) exhausted = true;
  return { content, messages: fromPi([...messages, ...result]), requests, exhausted };
}
