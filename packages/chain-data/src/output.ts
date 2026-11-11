import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const secretPatterns = new Map<string, RegExp>();
function jsonSecretPattern(secret: string): RegExp {
  const cached = secretPatterns.get(secret);
  if (cached) return cached;
  const escape = (text: string) => text.split('').map(char =>
    '^$\\.*+?()[]{}|'.includes(char) ? String.fromCharCode(92) + char : char).join('');
  const pattern = secret.split('').map(char => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, '0').split('').map(digit =>
      'abcdef'.includes(digit) ? `[${digit}${digit.toUpperCase()}]` : digit).join('');
    const unicode = String.fromCharCode(92, 92) + 'u' + hex;
    return `(?:${escape(char)}|${escape(JSON.stringify(char).slice(1, -1))}|${unicode})`;
  }).join('');
  const compiled = new RegExp(pattern, 'g');
  secretPatterns.set(secret, compiled);
  return compiled;
}

export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
        new URLSearchParams({ k: secret }).toString().slice(2)])) {
        text = text.split(form).join('[REDACTED]');
      }
      // Raw JSON can echo keys with any mixture of literal and Unicode-escaped characters.
      text = text.replace(jsonSecretPattern(secret), '[REDACTED]');
    }
    return text.replace(/([?&](?:api_?key|token|secret)=)[^\s&#"']*/gi, '$1[REDACTED]')
      .replace(/(https:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/)[^\s?"'<>]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(redact(k, secrets)),
      /^(api_?key|alchemy_?api_?key|etherscan_?api_?key|authorization|secret|token)$/i.test(k)
        ? '[REDACTED]' : redact(v, secrets)]));
  }
  return value;
}

export class Results {
  readonly directory: string;
  private sequence = 0;
  constructor(base: string, private readonly secrets: string[]) {
    this.directory = join(base, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  }
  async save(label: string, data: unknown): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = `${String(++this.sequence).padStart(4, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    const path = join(this.directory, name);
    // Redact values before serialization so escaping cannot corrupt the JSON envelope.
    const body = JSON.stringify(redact(data, this.secrets), null, 2);
    await writeFile(path, body + '\n', { flag: 'wx', mode: 0o600 });
    return path;
  }
}
