import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact, type QueryResult } from '@ledgerscout/chain-data';
export const validId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
export type SessionData = { version: 1; sessionId: string; addresses: string[];
  turns: { user: string; assistant: string }[]; queries: QueryResult[] };
async function atomicText(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, path);
}
export async function atomicJson(path: string, value: unknown) {
  await atomicText(path, JSON.stringify(value, null, 2) + '\n');
}

export class SessionStore {
  readonly directory: string;
  data: SessionData;
  interruptedRuns: string[] = [];
  constructor(base: string, readonly sessionId: string, private secrets: string[]) {
    if (!validId(sessionId)) throw new Error('Invalid session ID');
    this.directory = resolve(base, sessionId);
    this.data = { version: 1, sessionId, addresses: [], turns: [], queries: [] };
  }
  async open() {
    await mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'session.json'), 'utf8')) as SessionData;
      if (value.version !== 1 || value.sessionId !== this.sessionId || !Array.isArray(value.turns) || !Array.isArray(value.queries) || !Array.isArray(value.addresses)) throw new Error('Invalid session data');
      this.data = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^r_[a-zA-Z0-9_-]+$/.test(item.name)) continue;
      const dir = join(this.directory, item.name);
      try { await readFile(join(dir, 'run-summary.json')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.interruptedRuns.push(item.name);
        await atomicJson(join(dir, 'interrupted.json'), { status: 'interrupted', detectedAt: new Date().toISOString(), resumed: false });
      }
    }
  }
  async save() {
    this.data.turns = this.data.turns.slice(-20);
    this.data.queries = this.data.queries.slice(-32);
    await atomicJson(join(this.directory, 'session.json'), redact(this.data, this.secrets));
  }
}

export class RunJournal {
  readonly directory: string;
  private sequence = 0;
  private tail = Promise.resolve();
  constructor(store: SessionStore, readonly runId: string, private secrets: string[]) {
    this.directory = join(store.directory, runId);
  }
  async open() { await mkdir(this.directory, { recursive: true }); }
  event(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const record = redact({ ...payload, type, runId: this.runId, sequence: ++this.sequence, timestamp: new Date().toISOString() }, this.secrets);
    this.tail = this.tail.then(() => appendFile(join(this.directory, 'events.jsonl'), JSON.stringify(record) + '\n'));
    return this.tail;
  }
  async save(name: 'answer.json' | 'run-summary.json', value: unknown, recover = false) {
    await (recover ? this.tail.catch(() => {}) : this.tail);
    await atomicJson(join(this.directory, name), redact(value, this.secrets));
  }
  async finish(payload: Record<string, unknown>) {
    await this.tail.catch(() => {});
    const path = join(this.directory, 'events.jsonl');
    const text = await readFile(path, 'utf8');
    // A failed commit replaces its provisional terminal instead of appending a second one.
    const records = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type !== 'run_finished');
    records.push(redact({ ...payload, type: 'run_finished', runId: this.runId, sequence: ++this.sequence, timestamp: new Date().toISOString() }, this.secrets));
    await atomicText(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    this.tail = Promise.resolve();
  }
}
