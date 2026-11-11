import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { toDeepSeekPayload, workspaceRoot } from './model.js';
import type { TokenCount, TokenCounter } from './types.js';

export const tokenizerRevision = '935817c66f5d6e64838f419692545f06787e485f';
export const tokenizerDirectory = join(workspaceRoot, '.runtime', 'tokenizer');
export function createLocalTokenCounter(options: {
  model: string; python?: string; assetsDirectory?: string; workerPath?: string; timeoutMs?: number;
}): { count: TokenCounter; close: () => void } {
  const encoding = options.model === 'deepseek-flash' ? 'v41' : options.model === 'deepseek-v4-pro' ? 'v4' : undefined;
  if (!encoding) throw new Error('Unsupported tokenizer model');
  const verifiedEncoding = encoding;
  const assets = options.assetsDirectory ?? tokenizerDirectory;
  const python = options.python ?? join(tokenizerDirectory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const workerPath = options.workerPath ?? fileURLToPath(new URL('../scripts/count_tokens.py', import.meta.url));
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid tokenizer timeout');
  let child: ChildProcessWithoutNullStreams | undefined; let disabled = false; let sequence = 0; let buffer = '';
  const pending = new Map<number, { resolve: (value: TokenCount) => void; reject: (error: Error) => void; cleanup: () => void }>();
  const close = () => {
    disabled = true;
    for (const p of pending.values()) { p.cleanup(); p.reject(new Error('Local tokenizer unavailable')); }
    pending.clear();
    child?.kill('SIGKILL'); child = undefined;
  };
  function start() {
    // Deliberately do not inherit API credentials or Python path injection variables.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
    child = spawn(python, [workerPath, assets, options.model], { stdio: 'pipe', env });
    child.on('error', close); child.on('exit', close); child.stdin.on('error', close);
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8192) { close(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          const p = pending.get(value.id);
          if (!p || value.error || !Number.isSafeInteger(value.tokens) || value.tokens < 1 || value.tokens > 2_000_000 ||
            value.encoding !== encoding || value.revision !== tokenizerRevision) throw new Error('Invalid tokenizer response');
          pending.delete(value.id); p.cleanup();
          p.resolve({ tokens: value.tokens, method: 'local_tokenizer', encoding: verifiedEncoding, revision: tokenizerRevision });
        } catch { close(); return; }
      }
    });
  }
  const count: TokenCounter = async (messages, tools, signal) => {
    signal?.throwIfAborted();
    if (disabled) throw new Error('Local tokenizer unavailable');
    const id = ++sequence;
    const line = JSON.stringify({ id, payload: toDeepSeekPayload({ messages, tools }, options.model) }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > 262144) throw new Error('Tokenizer input too large');
    if (!child) start();
    return new Promise<TokenCount>((resolve, reject) => {
      const abort = () => close();
      const timer = setTimeout(close, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { close(); return; }
      child!.stdin.write(line, error => { if (error) close(); });
    });
  };
  return { count, close };
}
