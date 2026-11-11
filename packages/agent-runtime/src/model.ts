import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig, raceSignal, redact } from '@ledgerscout/chain-data';
import type { ModelReply, RequestModel } from './types.js';
export const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
export class ModelError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
export function loadRuntimeConfig(env = process.env) {
  let local: Record<string, string | undefined> = {};
  try { local = parseEnv(readFileSync(join(workspaceRoot, '.env'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read local model configuration'); }
  const key = (env.DEEPSEEK_API_KEY ?? local.DEEPSEEK_API_KEY ?? '').trim();
  const model = env.DEEPSEEK_MODEL ?? local.DEEPSEEK_MODEL ?? 'deepseek-flash';
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) throw new Error('DEEPSEEK_MODEL must be deepseek-flash or deepseek-v4-pro');
  return { key, model, chain: loadConfig(env), outputDirectory: join(workspaceRoot, 'runtime-results') };
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await raceSignal(reader.read(), signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 2_000_000) throw new ModelError('DeepSeek response is too large');
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export function createDeepSeekRequest(config: { key: string; model: string; maxOutputTokens?: number }, fetcher: typeof fetch = fetch): RequestModel {
  if (!config.key || /\s|^(YOUR_|replace|insert|paste|<)/i.test(config.key)) throw new Error('Missing or invalid DEEPSEEK_API_KEY; configure it in the local project .env');
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(config.model)) throw new Error('Unsupported DeepSeek model');
  const maxTokens = config.maxOutputTokens ?? 2000;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) throw new Error('Invalid model output limit');
  return async request => {
    request.signal?.throwIfAborted();
    if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1)) throw new ModelError('Invalid model output limit');
    const timeout = AbortSignal.timeout(30000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const messages = request.messages.map(m => {
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.callId };
      if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content || null,
        tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) };
      return { role: m.role, content: m.content };
    });
    let response: Response; let text: string;
    try {
      response = await raceSignal(fetcher('https://api.deepseek.com/chat/completions', {
        method: 'POST', signal, redirect: 'error',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, stream: false, max_tokens: Math.min(maxTokens, request.maxOutputTokens ?? maxTokens),
          thinking: { type: 'disabled' },
          ...(request.tools.length ? { tools: request.tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' } : { tool_choice: 'none' }) }),
      }), signal);
      text = await responseText(response, signal);
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (request.signal?.aborted) throw new ModelError('DeepSeek request cancelled');
      throw new ModelError(signal.aborted ? 'DeepSeek request timeout' : 'DeepSeek network failure', true);
    }
    if (!response.ok) {
      const quota = /insufficient.*balance|quota|daily.*limit|monthly.*limit/i.test(text);
      throw new ModelError(quota ? 'DeepSeek quota exhausted' : `DeepSeek HTTP ${response.status}`,
        !quota && (response.status === 429 || response.status >= 500));
    }
    let body: any;
    try { body = JSON.parse(text); } catch { throw new ModelError('DeepSeek returned invalid JSON'); }
    const choice = body?.choices?.[0]; const message = choice?.message;
    if (!Array.isArray(body?.choices) || body.choices.length !== 1 || message?.role !== 'assistant' ||
      !(message.content === null || typeof message.content === 'string')) throw new ModelError('DeepSeek returned an invalid response');
    if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw new ModelError('DeepSeek generation did not complete', choice.finish_reason === 'insufficient_system_resource');
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 128) throw new ModelError('DeepSeek returned invalid tool calls');
    const seen = new Set(request.messages.flatMap(m => m.toolCalls?.map(c => c.id) ?? []));
    const toolCalls = calls.map((call: any) => {
      if (typeof call?.id !== 'string' || !call.id || call.id.length > 200 || seen.has(call.id) || call.type !== 'function' ||
        typeof call.function?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name) ||
        typeof call.function.arguments !== 'string' || call.function.arguments.length > 16000) throw new ModelError('DeepSeek returned an invalid tool call');
      seen.add(call.id);
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { throw new ModelError('DeepSeek returned malformed tool arguments'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ModelError('DeepSeek returned invalid tool arguments');
      return { id: call.id, name: call.function.name, arguments: args };
    });
    const reply: ModelReply = { content: message.content ?? '', toolCalls, truncated: choice.finish_reason === 'length' };
    if (body.usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(body.usage[k]) && body.usage[k] >= 0)) {
      reply.usage = { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens, totalTokens: body.usage.total_tokens };
    }
    return redact(reply, [config.key]) as ModelReply;
  };
}
